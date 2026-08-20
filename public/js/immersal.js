/**
 * Immersal VPS 측위 클라이언트.
 *
 * 흐름:
 *   1) 측위를 요청하면 파이프라인에서 "그 프레임의 이미지 + 그 프레임의 카메라 포즈" 를 한 쌍으로 잡는다
 *   2) 그레이스케일 PNG(base64)로 인코딩해 서버 프록시로 POST
 *   3) 서버가 Immersal /localizeb64 로 중계 → 맵 좌표계 기준 카메라 포즈 수신
 *   4) T_track_map = T_track_cam · inverse(T_map_cam) 을 콘텐츠 루트에 적용
 *
 * 자기 검증:
 *   떨어진 두 지점에서 측위하면 정답 없이도 정렬을 판정할 수 있다.
 *   - Immersal 이 말하는 이동거리 ÷ SLAM 이 말하는 이동거리 = 1.00 이어야 한다
 *   - 여러 쌍에서 이 비율이 "일정하게" 1 을 벗어나면 계통 오차(초점거리·씬 스케일),
 *     "제각각" 이면 측위 자체가 불안정(맵 품질)이다. 편차를 함께 재는 이유다.
 */
(function () {
  const I = () => new THREE.Matrix4();
  const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);

  /**
   * 포즈 규약 후보.
   *
   * 정답은 2번이다. Immersal 공식 WebAR 구현(immersal/vps-for-web)이
   *   axisRot.rotateX(Math.PI);      // X축 180° = diag(1,-1,-1)
   *   Q.multiply(axisRot);           // 응답 회전에 후곱
   * 를 하고, 회전행렬은 [[r00,r01,r02],[r10,...]] 로 행 우선 해석한다.
   * 즉 transpose 없이 post = diag(1,-1,-1) — 아래 2번과 같다.
   *
   * 나머지 후보는 현장에서 뭔가 어긋날 때 비교용으로만 남겨 둔다.
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
  const MIN_BASELINE = 1.2;   // 스케일 추정에 쓸 두 측위 사이 최소 이동 거리(m).
                              // 짧으면 측위 오차가 비율을 지배해 값이 요동친다.
  const MAX_SAMPLES = 12;

  const median = (arr) => {
    if (!arr.length) return NaN;
    const a = [...arr].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  class ImmersalLocalizer {
    constructor({rootEl, cameraEl, onStatus, onDiagnostics}) {
      this.rootEl = rootEl;         // 맵 좌표계로 저작된 콘텐츠가 들어가는 a-entity
      this.cameraEl = cameraEl;     // 씬 그래프상의 카메라 (좌표계 기준점)
      this.onStatus = onStatus || (() => {});
      this.onDiagnostics = onDiagnostics || (() => {});

      this.reality = null;          // XR8 의 reality (렌즈 파라미터용)
      this.busy = false;
      this.attempts = 0;
      this.successes = 0;
      this.localized = false;
      this.timer = null;
      this.serverReady = false;

      this.conventionIndex = 0;
      this.autoConvention = true;
      this.gravityLock = true;
      this.samples = [];            // [{r, cam: Matrix4, camPos, mapPos}]
      this.diagnostics = null;

      // 정렬 적용 정책 — 측위는 계속 돌지만 매번 덮어쓰면 콘텐츠가 튄다.
      this.applied = false;
      this.smoothing = 0.25;
      this.outlierMeters = 1.5;
      this.lastShift = 0;
      this.rejected = 0;

      // 초점거리 보정.
      // reality.intrinsics 는 화면에 맞춰 잘린 렌더 투영이라 그대로 쓰면 과대평가된다.
      // 측정된 스케일 비율이 곧 초점거리 오차 배수이므로 그것으로 자가 보정한다.
      // 초점거리는 "계산해서 넣는 값" 이 아니라 조회하거나 추정하는 값이다.
      // 공식 구현은 기기 DB(/devget, Pro 플랜 필요)를 쓰고, 없으면 측위를 누적하며
      // 추정한다. 우리는 무료 플랜이라 DB 를 못 쓰므로 화각 가정으로 시작해
      // 스케일 비율로 보정하고, 수렴한 값을 기기별로 저장해 다음 세션에 재사용한다.
      this.focalPx = null;
      this.focalSource = '미정';
      this.initialFovDeg = 64;
      this.autoCalibrate = true;
      this.calibrations = 0;
      this.lastFocal = null;
      this.sendOrientationPrior = false;

      this._captureWaiters = [];
      this._pendingFrame = null;

      // 여러 맵을 동시에 켜두면(IMMERSAL_MAP_IDS 에 쉼표로 나열) Immersal 이 둘 다
      // 시도하고 응답의 map 필드로 어느 쪽이 매칭됐는지 알려준다.
      // ⚠ 맵마다 좌표계가 다르므로 샘플을 섞으면 안 된다. 매칭된 맵이 바뀌면 정렬을 새로 잡는다.
      this.activeMapId = null;
      this.mapStats = {};           // {mapId: 성공 횟수}
    }

    setConvention(i) {
      this.autoConvention = false;
      this.conventionIndex = ((i % CONVENTIONS.length) + CONVENTIONS.length) % CONVENTIONS.length;
      const c = CONVENTIONS[this.conventionIndex];
      if (this.samples.length) {
        this.applied = false;
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

    /**
     * 파이프라인 등록.
     *
     * 이미지와 카메라 포즈는 반드시 "같은 프레임" 이어야 한다.
     * 예전에는 이미지를 매 프레임 참조만 해두고 카메라 행렬은 요청 시점에 따로 읽어서,
     * 걸어다니는 동안 둘이 어긋났다. 게다가 pixels 는 재사용 버퍼라 나중에 인코딩하면
     * 이미 다음 프레임 내용일 수 있었다.
     * → 요청이 있을 때만, 콜백 안에서 픽셀을 복사하고 그 시점 카메라 행렬을 함께 잡는다.
     */
    attachPipeline(maxDimension) {
      XR8.addCameraPipelineModule(
        XR8.CameraPixelArray.pipelineModule({luminance: true, maxDimension})
      );
      XR8.addCameraPipelineModule({
        name: 'immersal-capture',
        onProcessCpu: ({processGpuResult}) => {
          if (!this._captureWaiters.length) return;
          const a = processGpuResult.camerapixelarray;
          if (a && a.pixels) {
            this._pendingFrame = {pixels: a.pixels, cols: a.cols, rows: a.rows, rowBytes: a.rowBytes || a.cols};
          }
        },
        onUpdate: ({processCpuResult}) => {
          const r = processCpuResult.reality;
          if (r) this.reality = r;
          if (!this._pendingFrame || !this._captureWaiters.length) return;

          // 이 시점에는 xrweb 이 이번 프레임의 카메라를 이미 배치했다.
          const cam3D = this.cameraEl.object3D;
          cam3D.updateMatrixWorld(true);
          const snap = {
            gray: this._packLuminance(this._pendingFrame),   // 복사본
            cols: this._pendingFrame.cols,
            rows: this._pendingFrame.rows,
            cam: cam3D.matrixWorld.clone(),
          };
          this._pendingFrame = null;
          const waiters = this._captureWaiters;
          this._captureWaiters = [];
          waiters.forEach((resolve) => resolve(snap));
        },
      });
    }

    /** 다음 프레임의 이미지+포즈 한 쌍을 받는다. */
    captureFrame(timeoutMs = 2000) {
      return new Promise((resolve) => {
        this._captureWaiters.push(resolve);
        setTimeout(() => {
          const i = this._captureWaiters.indexOf(resolve);
          if (i >= 0) { this._captureWaiters.splice(i, 1); resolve(null); }
        }, timeoutMs);
      });
    }

    /** padding 을 제거하며 새 배열로 복사한다(재사용 버퍼를 붙들지 않기 위해). */
    _packLuminance({pixels, cols, rows, rowBytes}) {
      const out = new Uint8Array(cols * rows);
      if (rowBytes === cols) {
        out.set(pixels.subarray(0, cols * rows));
      } else {
        for (let y = 0; y < rows; y++) {
          out.set(pixels.subarray(y * rowBytes, y * rowBytes + cols), y * cols);
        }
      }
      return out;
    }

    _focalKey(cols, rows) { return `immersal.focal.${cols}x${rows}`; }

    /**
     * 캡처 해상도 기준 fx/fy/ox/oy.
     *
     * ⚠ reality.intrinsics(엔진의 GraphicsCamera 투영행렬)는 쓰지 않는다.
     *   그건 화면 종횡비에 맞춰 한 축이 잘린 렌더용이라, 잘리지 않은 전체 프레임을
     *   주는 CameraPixelArray 에 적용하면 초점거리가 크롭 배수만큼 과대평가된다.
     *   공식 구현도 이 값을 쓰지 않고 기기 DB 또는 추정에 의존한다.
     *
     * 픽셀은 정사각형이므로 fx = fy, 주점은 이미지 중심으로 둔다.
     */
    _intrinsics(cols, rows) {
      if (this.focalPx == null) {
        const saved = Number(localStorage.getItem(this._focalKey(cols, rows)));
        if (saved > 0) {
          this.focalPx = saved;
          this.focalSource = '저장값';
          Log.info(`[immersal] 저장된 초점거리 ${saved.toFixed(0)}px 재사용 (${cols}x${rows})`);
        } else {
          // 폰 후면 카메라 통상 화각으로 시작. 이후 스케일 비율로 보정된다.
          const longSide = Math.max(cols, rows);
          this.focalPx = longSide / (2 * Math.tan((this.initialFovDeg * Math.PI / 180) / 2));
          this.focalSource = `화각 ${this.initialFovDeg}° 가정`;
          Log.info(`[immersal] 초점거리 초기값 ${this.focalPx.toFixed(0)}px (${this.focalSource})`);
        }
      }
      this.lastFocal = {f: this.focalPx, source: this.focalSource};
      return {fx: this.focalPx, fy: this.focalPx, ox: cols / 2, oy: rows / 2, estimated: false};
    }

    async localizeOnce() {
      if (this.busy || !this.serverReady) return false;

      this.busy = true;
      this.attempts++;
      this.onStatus('pending');
      const t0 = performance.now();

      try {
        const snap = await this.captureFrame();
        if (!snap) { Log.warn('[immersal] 카메라 프레임을 못 받음'); this.onStatus('fail'); return false; }

        const {gray, cols, rows, cam} = snap;
        this._lastDims = {cols, rows};
        const b64 = await window.PNGEncoder.encodeGray8(gray, cols, rows);
        const {fx, fy, ox, oy} = this._intrinsics(cols, rows);

        const body = {b64, fx, fy, ox, oy};

        // 기기 자세 prior. 공식 구현은 gyro·axisRot 로 만든 쿼터니언과 solverType 을 함께 보낸다.
        // 우리 카메라 회전은 "트래킹 프레임" 기준이라 맵 프레임과 yaw 원점이 다르다.
        // 정렬이 한 번 끝난 뒤에는 루트 변환으로 맵 프레임으로 바꿀 수 있으므로 그때만 보낸다.
        if (this.sendOrientationPrior && this.applied) {
          const camQ = new THREE.Quaternion().setFromRotationMatrix(cam);
          const rootQ = new THREE.Quaternion();
          this.rootEl.object3D.getWorldQuaternion(rootQ);
          const q = rootQ.invert().multiply(camQ)            // 트래킹 → 맵 프레임
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
          Object.assign(body, {qx: q.x, qy: q.y, qz: q.z, qw: q.w, solverType: 1});
        }

        const res = await fetch('/api/immersal/localize', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
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
        this._addSample(json, cam);
        Log.info(`[immersal] 성공 #${this.successes} conf=${json.confidence ?? '-'} f=${fx.toFixed(0)}px(${this.focalSource}) ${cols}x${rows} ${ms}ms`);

        if (this.autoConvention) this._pickConvention();
        this._applyLatest();
        this._runDiagnostics();
        this._maybeCalibrate();

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
      const mapId = r.map;
      this.mapStats[mapId] = (this.mapStats[mapId] || 0) + 1;

      if (this.activeMapId == null) {
        this.activeMapId = mapId;
      } else if (mapId !== this.activeMapId) {
        // 다른 맵이 매칭됐다. 좌표계가 다르므로 이전 샘플·정렬을 버리고 새로 시작한다.
        Log.warn(`[immersal] 매칭된 맵이 ${this.activeMapId} → ${mapId} 로 바뀜. 정렬을 새로 잡습니다`);
        this.activeMapId = mapId;
        this.samples = [];
        this.applied = false;
      }

      this.samples.push({
        r,
        cam: camMatrix,
        camPos: new THREE.Vector3().setFromMatrixPosition(camMatrix),
        mapPos: new THREE.Vector3(r.px, r.py, r.pz),
      });
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

    /** 기준선이 충분한 모든 샘플 쌍 */
    _pairs() {
      const out = [];
      for (let a = 0; a < this.samples.length; a++) {
        for (let b = a + 1; b < this.samples.length; b++) {
          const A = this.samples[a];
          const B = this.samples[b];
          const dSlam = A.camPos.distanceTo(B.camPos);
          if (dSlam < MIN_BASELINE) continue;
          out.push({A, B, dSlam, dMap: A.mapPos.distanceTo(B.mapPos)});
        }
      }
      return out;
    }

    _compare(TA, TB) {
      const pA = new THREE.Vector3(); const qA = new THREE.Quaternion(); const sA = new THREE.Vector3();
      const pB = new THREE.Vector3(); const qB = new THREE.Quaternion(); const sB = new THREE.Vector3();
      TA.decompose(pA, qA, sA);
      TB.decompose(pB, qB, sB);
      return {pos: pA.distanceTo(pB), deg: qA.angleTo(qB) * 180 / Math.PI};
    }

    /**
     * 규약 선택.
     *  - 기준선이 충분한 쌍이 있으면: 쌍마다 계산한 변환이 가장 잘 일치하는 규약 (강한 근거)
     *  - 없으면: 중력 어긋남이 가장 작은 규약 (약한 근거)
     */
    _pickConvention() {
      const pairs = this._pairs();
      const scores = [];

      for (let i = 0; i < CONVENTIONS.length; i++) {
        if (pairs.length) {
          const errs = pairs.map((p) => {
            const TA = this._computeRootTransform(p.A.r, p.A.cam, i);
            const TB = this._computeRootTransform(p.B.r, p.B.cam, i);
            const {pos, deg} = this._compare(TA, TB);
            return pos + deg * 0.02;
          });
          scores.push({i, score: median(errs), label: `일치오차 ${median(errs).toFixed(2)}`});
        } else {
          const last = this.samples[this.samples.length - 1];
          const T = this._computeRootTransform(last.r, last.cam, i);
          const q = new THREE.Quaternion();
          T.decompose(new THREE.Vector3(), q, new THREE.Vector3());
          const tilt = UP.clone().applyQuaternion(q).angleTo(UP) * 180 / Math.PI;
          scores.push({i, score: tilt, label: `기울기 ${tilt.toFixed(0)}°`});
        }
      }

      const best = scores.reduce((a, b) => (b.score < a.score ? b : a));
      if (best.i !== this.conventionIndex) {
        scores.forEach((s) => Log.info(`[immersal]   후보 ${CONVENTIONS[s.i].name} — ${s.label}`));
        Log.info(`[immersal] 규약 선택 → ${CONVENTIONS[best.i].name} (${pairs.length ? `쌍 ${pairs.length}개 일치 기준` : '중력 기준'})`);
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
        // 회전을 평탄화했으면 평행이동도 다시 풀어야 한다. 안 그러면 맵 원점을 축으로
        // 전체가 휘둘려, 원점에서 먼 콘텐츠일수록 밀린다.
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
        quat.setFromEuler(new THREE.Euler(0, Math.atan2(-fwd.x, -fwd.z), 0));
        const camWorld = new THREE.Vector3().setFromMatrixPosition(last.cam);
        pos.copy(camWorld).sub(last.mapPos.clone().applyQuaternion(quat));
      }

      const o = this.rootEl.object3D;
      const f = (n) => n.toFixed(2);

      if (!this.applied) {
        o.position.copy(pos);
        o.quaternion.copy(quat);
        o.scale.set(1, 1, 1);
        this.applied = true;
        this.lastShift = 0;
        Log.info(`[immersal] ${this.conventionName()} → 최초 정렬 (${f(pos.x)}, ${f(pos.y)}, ${f(pos.z)}) 기울기 ${tilt.toFixed(0)}°`);
      } else {
        const shift = pos.distanceTo(o.position);
        this.lastShift = shift;
        if (shift > this.outlierMeters) {
          this.rejected++;
          Log.warn(`[immersal] 이상치 무시 — 정렬이 ${shift.toFixed(2)}m 튐 (누적 ${this.rejected})`);
          return;
        }
        o.position.lerp(pos, this.smoothing);
        o.quaternion.slerp(quat, this.smoothing);
      }
      o.updateMatrixWorld(true);
    }

    /**
     * 정답 없이 정렬을 판정한다.
     *
     * 핵심은 "편차" 다. 여러 쌍의 비율이 **일정하게** 1 을 벗어나면 계통 오차이고,
     * **제각각** 이면 측위 자체가 불안정하다는 뜻이다. 이 둘을 구분해야
     * 코드를 고칠지 맵을 다시 만들지 판단할 수 있다.
     */
    _runDiagnostics() {
      const pairs = this._pairs();
      if (!pairs.length) {
        this.diagnostics = {ready: false, samples: this.samples.length, focal: this.lastFocal};
        this.onDiagnostics(this.diagnostics);
        return;
      }

      const ratios = pairs.map((p) => p.dMap / p.dSlam);
      const med = median(ratios);
      // 상대 중앙절대편차 — 이상치에 휘둘리지 않는 흩어짐 지표
      const spread = med > 0 ? median(ratios.map((r) => Math.abs(r - med))) / med : NaN;

      // 규약별이 아니라 현재 규약에서의 변환 일치도
      const agree = pairs.map((p) => {
        const TA = this._computeRootTransform(p.A.r, p.A.cam, this.conventionIndex);
        const TB = this._computeRootTransform(p.B.r, p.B.cam, this.conventionIndex);
        return this._compare(TA, TB);
      });

      this.diagnostics = {
        ready: true,
        samples: this.samples.length,
        pairs: pairs.length,
        scaleRatio: med,
        spread,
        systematic: spread < 0.15,       // 흩어짐이 작으면 계통 오차
        agreePos: median(agree.map((a) => a.pos)),
        agreeDeg: median(agree.map((a) => a.deg)),
        lastShift: this.lastShift,
        rejected: this.rejected,
        focal: this.lastFocal,
        calibrations: this.calibrations,
        activeMapId: this.activeMapId,
        mapStats: {...this.mapStats},
        baseline: Math.max(...pairs.map((p) => p.dSlam)),
      };
      // 편차(비율)에 기준선을 곱하면 측위 위치 오차의 대략적인 크기(m)가 된다.
      // 합성 실험에서 이 관계가 선형으로 확인됐다(±0.05m→1%, ±0.5m→10%).
      this.diagnostics.estError = spread * this.diagnostics.baseline;

      const d = this.diagnostics;
      d.ok = Math.abs(d.scaleRatio - 1) < 0.1 && d.agreePos < 0.4 && d.agreeDeg < 6;
      Log.info(`[진단] 쌍 ${d.pairs}개 · 스케일 ${d.scaleRatio.toFixed(3)} (편차 ${(spread * 100).toFixed(0)}%) · 일치 ${d.agreePos.toFixed(2)}m/${d.agreeDeg.toFixed(1)}°`);
      this.onDiagnostics(d);
    }

    /**
     * 자가 보정 — 측정된 스케일 비율이 곧 초점거리 오차 배수다.
     * 흩어짐이 작을 때(= 계통 오차일 때)만 적용하고, 적용 후 샘플을 비운다.
     */
    /**
     * 초점거리 자가 보정.
     * 측정된 스케일 비율이 곧 초점거리 오차 배수다. 흩어짐이 작을 때(계통 오차)만 적용한다.
     * 수렴한 값은 기기·해상도별로 저장해 다음 세션에서 바로 쓴다.
     */
    _maybeCalibrate() {
      if (!this.autoCalibrate) return;
      const d = this.diagnostics;
      if (!d || !d.ready || !d.systematic) return;
      if (d.pairs < 2 || this.calibrations >= 6) return;
      if (Math.abs(d.scaleRatio - 1) < 0.05) return;

      const next = this.focalPx / d.scaleRatio;
      if (!(next > 100 && next < 5000)) {
        Log.warn(`[보정] 초점거리 ${next.toFixed(0)}px 가 범위를 벗어나 적용하지 않음`);
        return;
      }

      this.calibrations++;
      Log.info(`[보정] 스케일 ${d.scaleRatio.toFixed(3)} (편차 ${(d.spread * 100).toFixed(0)}%) → 초점거리 ${this.focalPx.toFixed(0)} → ${next.toFixed(0)}px (${this.calibrations}회)`);
      this.focalPx = next;
      this.focalSource = `보정 ${this.calibrations}회`;
      if (this._lastDims) {
        try { localStorage.setItem(this._focalKey(this._lastDims.cols, this._lastDims.rows), String(next)); } catch (e) {}
      }

      // 이전 샘플은 옛 초점거리로 계산된 값이라 섞으면 안 된다.
      this.samples = [];
      this.applied = false;
      this.diagnostics = {ready: false, samples: 0, focal: this.lastFocal, calibrations: this.calibrations};
      this.onDiagnostics(this.diagnostics);
    }

    /** 저장된 보정값을 지우고 처음부터 다시 추정한다. */
    resetFocal() {
      if (this._lastDims) {
        try { localStorage.removeItem(this._focalKey(this._lastDims.cols, this._lastDims.rows)); } catch (e) {}
      }
      this.focalPx = null;
      this.calibrations = 0;
      this.samples = [];
      this.applied = false;
      Log.info('[보정] 초점거리 초기화 — 다시 추정합니다');
    }

    startAuto({intervalMs, maxAttempts, continuous}) {
      this.stopAuto();
      this.timer = setInterval(() => {
        if (this.attempts >= maxAttempts) { this.stopAuto(); return; }
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
