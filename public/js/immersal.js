/**
 * Immersal VPS 측위 클라이언트.
 *
 * 흐름:
 *   1) 8th Wall 파이프라인에서 카메라 휘도 픽셀 + 렌즈 파라미터를 매 프레임 캐싱
 *   2) 그레이스케일 PNG(base64)로 인코딩해 서버 프록시로 POST
 *   3) 서버가 Immersal /localizeb64 로 중계 → 맵 좌표계 기준 카메라 포즈 수신
 *   4) T_track_map = T_track_cam · inverse(T_map_cam) 을 콘텐츠 루트에 적용
 *
 * 자기 검증:
 *   서로 떨어진 두 지점에서 측위하면 정답 없이도 정렬을 판정할 수 있다.
 *   - Immersal 이 말하는 이동거리와 SLAM 이 말하는 이동거리는 같아야 한다 → 스케일 검증
 *   - 두 측위에서 각각 계산한 맵→씬 변환은 같아야 한다 → 좌표 규약 검증
 *   이 지표로 규약을 고르면 중력 휴리스틱보다 근거가 훨씬 강하다.
 */
(function () {
  const I = () => new THREE.Matrix4();
  const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);

  /**
   * 포즈 규약 후보.
   * 문서상 Immersal 응답은 "오른손 좌표계, ARKit 중력 정렬"의 camera-to-map 포즈다.
   * three.js 와 같은 규약이라 0번(변환 없음)이 유력하지만,
   * "rotation is submitted as a row matrix" 표현 때문에 행/열 해석에 여지가 있다.
   *
   *   T_map_cam = pre · [R(또는 Rᵀ) | t] · post   (invert 면 최종 역행렬)
   */
  const CONVENTIONS = [
    {name: '0:그대로',      pre: I(),         post: I(),          transpose: false, invert: false},
    {name: '1:전치',        pre: I(),         post: I(),          transpose: true,  invert: false},
    {name: '2:YZ반전',      pre: I(),         post: S(1, -1, -1), transpose: false, invert: false},
    {name: '3:YZ반전+전치', pre: I(),         post: S(1, -1, -1), transpose: true,  invert: false},
    {name: '4:Z켤레',       pre: S(1, 1, -1), post: S(1, 1, -1),  transpose: false, invert: false},
    {name: '5:Z켤레+전치',  pre: S(1, 1, -1), post: S(1, 1, -1),  transpose: true,  invert: false},
    {name: '6:Y켤레',       pre: S(1, -1, 1), post: S(1, -1, 1),  transpose: false, invert: false},
    {name: '7:뷰행렬 해석', pre: I(),         post: I(),          transpose: false, invert: true},
  ];

  const UP = new THREE.Vector3(0, 1, 0);
  const MIN_BASELINE = 0.6;   // 진단에 쓸 두 측위 사이 최소 이동 거리(m)
  const MAX_SAMPLES = 8;

  class ImmersalLocalizer {
    constructor({rootEl, cameraEl, onStatus, onDiagnostics}) {
      this.rootEl = rootEl;         // 맵 좌표계로 저작된 콘텐츠가 들어가는 a-entity
      this.cameraEl = cameraEl;     // 씬 그래프상의 카메라 (좌표계 기준점)
      this.onStatus = onStatus || (() => {});
      this.onDiagnostics = onDiagnostics || (() => {});

      this.frame = null;            // {pixels, cols, rows, rowBytes}
      this.reality = null;          // XR8 의 reality (렌즈 intrinsics 용)
      this.busy = false;
      this.attempts = 0;
      this.successes = 0;
      this.localized = false;
      this.timer = null;
      this.serverReady = false;

      this.conventionIndex = 0;
      this.autoConvention = true;
      this.gravityLock = true;
      this.samples = [];            // [{r, cam: Matrix4, camPos: Vector3}]
      this.diagnostics = null;
    }

    setConvention(i) {
      this.autoConvention = false;  // 손으로 고른 순간부터 자동 선택을 멈춘다
      this.conventionIndex = ((i % CONVENTIONS.length) + CONVENTIONS.length) % CONVENTIONS.length;
      const c = CONVENTIONS[this.conventionIndex];
      if (this.samples.length) {
        this._applyLatest();
        this._runDiagnostics();
        Log.info(`[immersal] 규약 → ${c.name} (재정렬 완료)`);
      } else {
        Log.warn(`[immersal] 규약 → ${c.name} (측위 성공 기록이 없어 적용만 예약)`);
      }
      return c.name;
    }

    conventionName() { return CONVENTIONS[this.conventionIndex].name; }

    async checkServer() {
      try {
        const r = await fetch('/api/config');
        const j = await r.json();
        this.serverReady = Boolean(j.immersalConfigured);
        Log.info(`[immersal] 서버 설정: ${this.serverReady ? `맵 ${j.mapIds.join(',')}` : '미설정'}`);
      } catch (e) {
        this.serverReady = false;
        Log.warn('[immersal] /api/config 조회 실패:', e.message);
      }
      this.onStatus(this.serverReady ? 'idle' : 'disabled');
      return this.serverReady;
    }

    attachPipeline(maxDimension) {
      XR8.addCameraPipelineModule(
        XR8.CameraPixelArray.pipelineModule({luminance: true, maxDimension})
      );
      XR8.addCameraPipelineModule({
        name: 'immersal-capture',
        onProcessCpu: ({processGpuResult}) => {
          const a = processGpuResult.camerapixelarray;
          if (a && a.pixels) {
            this.frame = {pixels: a.pixels, cols: a.cols, rows: a.rows, rowBytes: a.rowBytes || a.cols};
          }
        },
        onUpdate: ({processCpuResult}) => {
          const r = processCpuResult.reality;
          if (r) this.reality = r;
        },
      });
    }

    _packLuminance() {
      const {pixels, cols, rows, rowBytes} = this.frame;
      if (rowBytes === cols) return pixels.subarray(0, cols * rows);
      const out = new Uint8Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        out.set(pixels.subarray(y * rowBytes, y * rowBytes + cols), y * cols);
      }
      return out;
    }

    /** 렌더 투영행렬에서 캡처 해상도 기준 fx/fy/ox/oy 를 뽑는다. */
    _intrinsics(cols, rows) {
      const m = this.reality && this.reality.intrinsics;
      if (!m || m.length < 10 || !m[0]) {
        const f = cols / (2 * Math.tan((60 * Math.PI / 180) / 2));   // 화각 60° 가정
        return {fx: f, fy: f, ox: cols / 2, oy: rows / 2, estimated: true};
      }
      const ox = ((m[8] + 1) * cols) / 2;
      const oy = ((m[9] + 1) * rows) / 2;
      return {
        fx: Math.abs((m[0] * cols) / 2),
        fy: Math.abs((m[5] * rows) / 2),
        ox: Number.isFinite(ox) ? Math.abs(ox) : cols / 2,
        oy: Number.isFinite(oy) ? Math.abs(oy) : rows / 2,
        estimated: false,
      };
    }

    async localizeOnce() {
      if (this.busy || !this.serverReady) return false;
      if (!this.frame) { Log.warn('[immersal] 아직 카메라 프레임 없음'); return false; }

      this.busy = true;
      this.attempts++;
      this.onStatus('pending');
      const t0 = performance.now();

      try {
        const {cols, rows} = this.frame;
        const gray = this._packLuminance();
        const b64 = await window.PNGEncoder.encodeGray8(gray, cols, rows);
        const {fx, fy, ox, oy, estimated} = this._intrinsics(cols, rows);
        if (estimated) Log.warn('[immersal] intrinsics 추정값 사용 중 (정확도 저하 가능)');

        // 요청 시점의 카메라 포즈를 고정한다(응답이 오는 ~1초 사이 카메라가 움직이므로).
        //
        // XR8 의 reality.position 이 아니라 "씬 그래프상의 카메라 월드 행렬" 을 쓴다.
        // xrweb 은 카메라를 재부모화(disableCameraReparenting: false)하므로 두 값이
        // 어긋날 수 있고, 콘텐츠 루트는 씬 그래프에 있으니 씬 기준이 맞다.
        const cam3D = this.cameraEl.object3D;
        cam3D.updateMatrixWorld(true);
        const camMatrix = cam3D.matrixWorld.clone();

        const res = await fetch('/api/immersal/localize', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({b64, fx, fy, ox, oy}),
        });
        const json = await res.json();
        const ms = Math.round(performance.now() - t0);

        if (!res.ok || json.success === false || (json.error && json.error !== 'none')) {
          const why = json.error && json.error !== 'none' ? json.error
            : (json.success === false ? '맵과 매칭 안 됨' : res.status);
          Log.warn(`[immersal] 측위 실패(${this.attempts}회, ${ms}ms): ${why}`);
          this.onStatus('fail');
          return false;
        }

        this.successes++;
        this._addSample(json, camMatrix);
        Log.info(`[immersal] 측위 성공 #${this.successes} map=${json.map} conf=${json.confidence ?? '-'} (${ms}ms)`);

        if (this.autoConvention) this._pickConvention();
        this._applyLatest();
        this._runDiagnostics();

        this.localized = true;
        this.onStatus('ok');
        this.rootEl.emit('immersal-localized', {response: json}, false);
        return true;
      } catch (e) {
        Log.error('[immersal] 오류:', e.message);
        this.onStatus('fail');
        return false;
      } finally {
        this.busy = false;
      }
    }

    _addSample(r, camMatrix) {
      const camPos = new THREE.Vector3().setFromMatrixPosition(camMatrix);
      this.samples.push({r, cam: camMatrix, camPos});
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    }

    /** 규약 i 로 T_track_map 을 계산한다 (적용하지 않음). */
    _computeRootTransform(r, camMatrix, i) {
      const c = CONVENTIONS[i];

      const M = new THREE.Matrix4();
      if (c.transpose) {
        M.set(r.r00, r.r10, r.r20, r.px,
              r.r01, r.r11, r.r21, r.py,
              r.r02, r.r12, r.r22, r.pz,
              0, 0, 0, 1);
      } else {
        M.set(r.r00, r.r01, r.r02, r.px,
              r.r10, r.r11, r.r12, r.py,
              r.r20, r.r21, r.r22, r.pz,
              0, 0, 0, 1);
      }

      let T_map_cam = new THREE.Matrix4().multiplyMatrices(c.pre, M).multiply(c.post);
      if (c.invert) T_map_cam = T_map_cam.clone().invert();

      const T_cam_map = new THREE.Matrix4().copy(T_map_cam).invert();
      return new THREE.Matrix4().multiplyMatrices(camMatrix, T_cam_map);
    }

    /** 진단에 쓸, 가장 멀리 떨어진 두 샘플. 충분히 안 떨어졌으면 null. */
    _pairForDiagnostics() {
      let best = null;
      for (let a = 0; a < this.samples.length; a++) {
        for (let b = a + 1; b < this.samples.length; b++) {
          const d = this.samples[a].camPos.distanceTo(this.samples[b].camPos);
          if (!best || d > best.d) best = {a: this.samples[a], b: this.samples[b], d};
        }
      }
      return best && best.d >= MIN_BASELINE ? best : null;
    }

    /** 두 변환의 위치·회전 차이 */
    _compare(TA, TB) {
      const pA = new THREE.Vector3(); const qA = new THREE.Quaternion(); const sA = new THREE.Vector3();
      const pB = new THREE.Vector3(); const qB = new THREE.Quaternion(); const sB = new THREE.Vector3();
      TA.decompose(pA, qA, sA);
      TB.decompose(pB, qB, sB);
      return {pos: pA.distanceTo(pB), deg: qA.angleTo(qB) * 180 / Math.PI};
    }

    /**
     * 규약 선택.
     *  - 떨어진 두 측위가 있으면: 둘이 계산한 변환이 가장 잘 일치하는 규약 (강한 근거)
     *  - 없으면: 중력 어긋남이 가장 작은 규약 (약한 근거)
     */
    _pickConvention() {
      const pair = this._pairForDiagnostics();
      const scores = [];

      for (let i = 0; i < CONVENTIONS.length; i++) {
        if (pair) {
          const TA = this._computeRootTransform(pair.a.r, pair.a.cam, i);
          const TB = this._computeRootTransform(pair.b.r, pair.b.cam, i);
          const {pos, deg} = this._compare(TA, TB);
          scores.push({i, score: pos + deg * 0.02, label: `일치오차 ${pos.toFixed(2)}m/${deg.toFixed(0)}°`});
        } else {
          const last = this.samples[this.samples.length - 1];
          const T = this._computeRootTransform(last.r, last.cam, i);
          const q = new THREE.Quaternion();
          T.decompose(new THREE.Vector3(), q, new THREE.Vector3());
          const tilt = UP.clone().applyQuaternion(q).angleTo(UP) * 180 / Math.PI;
          scores.push({i, score: tilt, label: `기울기 ${tilt.toFixed(0)}°`});
        }
      }

      scores.forEach((s) => Log.info(`[immersal]   후보 ${CONVENTIONS[s.i].name} — ${s.label}`));
      const best = scores.reduce((a, b) => (b.score < a.score ? b : a));
      if (best.i !== this.conventionIndex) {
        Log.info(`[immersal] 규약 선택 → ${CONVENTIONS[best.i].name} (${pair ? '두 지점 일치 기준' : '중력 기준'})`);
      }
      this.conventionIndex = best.i;
    }

    _applyLatest() {
      const last = this.samples[this.samples.length - 1];
      if (!last) return;
      const T = this._computeRootTransform(last.r, last.cam, this.conventionIndex);

      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      T.decompose(pos, quat, scl);

      const tilt = UP.clone().applyQuaternion(quat).angleTo(UP) * 180 / Math.PI;
      if (this.gravityLock) {
        // 두 좌표계 모두 중력 정렬이므로 pitch/roll 은 오차다. 버리면 더 안정적이다.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
        quat.setFromEuler(new THREE.Euler(0, Math.atan2(-fwd.x, -fwd.z), 0));
      }

      const o = this.rootEl.object3D;
      o.position.copy(pos);
      o.quaternion.copy(quat);
      o.scale.set(1, 1, 1);
      o.updateMatrixWorld(true);

      const f = (n) => n.toFixed(2);
      Log.info(`[immersal] ${this.conventionName()} → 루트 (${f(pos.x)}, ${f(pos.y)}, ${f(pos.z)}) 기울기 ${tilt.toFixed(0)}°`);
      if (Math.abs(scl.x - 1) > 0.05) {
        Log.warn(`[immersal] 변환에 배율 ${scl.x.toFixed(3)} 이 섞여 있다 — 씬 스케일 확인 필요`);
      }
    }

    /**
     * 정답 없이 정렬을 판정한다.
     *  - 스케일: Immersal 이 말하는 이동거리 ÷ SLAM 이 말하는 이동거리 (1.00 이어야 함)
     *  - 재현성: 두 측위가 각각 계산한 변환의 차이 (0 이어야 함)
     */
    _runDiagnostics() {
      const pair = this._pairForDiagnostics();
      if (!pair) {
        this.diagnostics = {ready: false, samples: this.samples.length};
        this.onDiagnostics(this.diagnostics);
        return;
      }

      const mapA = new THREE.Vector3(pair.a.r.px, pair.a.r.py, pair.a.r.pz);
      const mapB = new THREE.Vector3(pair.b.r.px, pair.b.r.py, pair.b.r.pz);
      const dMap = mapA.distanceTo(mapB);
      const dSlam = pair.d;
      const scaleRatio = dSlam > 0 ? dMap / dSlam : NaN;

      const TA = this._computeRootTransform(pair.a.r, pair.a.cam, this.conventionIndex);
      const TB = this._computeRootTransform(pair.b.r, pair.b.cam, this.conventionIndex);
      const {pos, deg} = this._compare(TA, TB);

      this.diagnostics = {
        ready: true,
        samples: this.samples.length,
        dMap, dSlam, scaleRatio,
        agreePos: pos, agreeDeg: deg,
        ok: Math.abs(scaleRatio - 1) < 0.1 && pos < 0.5 && deg < 8,
      };

      Log.info(`[진단] 이동 SLAM ${dSlam.toFixed(2)}m / Immersal ${dMap.toFixed(2)}m → 스케일 ${scaleRatio.toFixed(3)}`);
      Log.info(`[진단] 두 지점 변환 일치오차 ${pos.toFixed(2)}m / ${deg.toFixed(1)}° ${this.diagnostics.ok ? '(정상)' : '(정렬 불량)'}`);
      if (Math.abs(scaleRatio - 1) >= 0.1) {
        Log.error(`[진단] 스케일이 ${scaleRatio.toFixed(2)}배 어긋남 — 씬이 미터 단위가 아니다 (xrweb scale: absolute 확인)`);
      }
      this.onDiagnostics(this.diagnostics);
    }

    startAuto({intervalMs, maxAttempts, continuous}) {
      this.stopAuto();
      this.timer = setInterval(() => {
        if (this.attempts >= maxAttempts) { this.stopAuto(); return; }
        // 진단에는 서로 떨어진 두 측위가 필요하므로, 성공해도 계속 측위한다.
        if (!continuous && this.localized) { this.stopAuto(); return; }
        this.localizeOnce();
      }, intervalMs);
    }

    stopAuto() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  }

  window.ImmersalLocalizer = ImmersalLocalizer;
})();
