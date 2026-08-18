/**
 * Immersal VPS 측위 클라이언트.
 *
 * 흐름:
 *   1) 8th Wall 파이프라인에서 카메라 휘도 픽셀 + 카메라 내부/외부 파라미터를 매 프레임 캐싱
 *   2) 캐시된 프레임을 그레이스케일 PNG(base64)로 인코딩해 서버 프록시로 POST
 *   3) 서버가 Immersal /localizeb64 로 중계 → 맵 좌표계 기준 카메라 포즈 수신
 *   4) T_track_map = T_track_cam · inverse(T_map_cam) 을 계산해 콘텐츠 루트에 적용
 *
 * ⚠ 좌표계 주의: Immersal 은 OpenCV 규약(+X 오른쪽, +Y 아래, +Z 전방),
 *   three.js/WebGL 은 +Y 위, -Z 전방이다. 아래 CV_TO_GL 로 변환한다.
 *   실제 맵으로 첫 테스트할 때 축이 뒤집혀 보이면 이 행렬부터 의심할 것.
 */
(function () {
  const I = () => new THREE.Matrix4();
  const S = (x, y, z) => new THREE.Matrix4().makeScale(x, y, z);

  /**
   * 포즈 규약 후보들.
   *
   * Immersal 문서상 응답은 "오른손 좌표계, ARKit 중력 정렬"의 camera-to-map 포즈다.
   * 즉 three.js 와 같은 규약이므로 0번(변환 없음)이 가장 유력하다.
   * 다만 문서의 "rotation is submitted as a row matrix" 표현 때문에 행/열 해석에
   * 여지가 있어, 현장에서 눈으로 고를 수 있도록 후보를 나열해 둔다.
   *
   *   T_map_cam = pre · [R(또는 Rᵀ) | t] · post   (invert 면 최종적으로 역행렬)
   */
  const CONVENTIONS = [
    {name: '0:그대로',        pre: I(), post: I(),           transpose: false, invert: false},
    {name: '1:전치',          pre: I(), post: I(),           transpose: true,  invert: false},
    {name: '2:YZ반전',        pre: I(), post: S(1, -1, -1),  transpose: false, invert: false},
    {name: '3:YZ반전+전치',   pre: I(), post: S(1, -1, -1),  transpose: true,  invert: false},
    {name: '4:Z켤레',         pre: S(1, 1, -1), post: S(1, 1, -1),  transpose: false, invert: false},
    {name: '5:Z켤레+전치',    pre: S(1, 1, -1), post: S(1, 1, -1),  transpose: true,  invert: false},
    {name: '6:Y켤레',         pre: S(1, -1, 1), post: S(1, -1, 1),  transpose: false, invert: false},
    {name: '7:뷰행렬 해석',   pre: I(), post: I(),           transpose: false, invert: true},
  ];

  class ImmersalLocalizer {
    constructor({rootEl, onStatus}) {
      this.rootEl = rootEl;             // 맵 좌표계로 저작된 콘텐츠가 들어가는 a-entity
      this.onStatus = onStatus || (() => {});
      this.frame = null;                // {pixels, cols, rows, rowBytes}
      this.reality = null;              // {position, rotation, intrinsics}
      this.busy = false;
      this.attempts = 0;
      this.localized = false;
      this.timer = null;
      this.serverReady = false;
      this.conventionIndex = 0;   // 현재 적용 중인 포즈 규약
      this.lastResponse = null;   // 마지막 성공 응답 (규약 전환 시 재적용용)
      this.lastSnapshot = null;
    }

    /** 규약을 바꿔 저장된 마지막 응답으로 즉시 재정렬한다 (재측위 불필요). */
    setConvention(i) {
      this.conventionIndex = ((i % CONVENTIONS.length) + CONVENTIONS.length) % CONVENTIONS.length;
      const c = CONVENTIONS[this.conventionIndex];
      if (this.lastResponse) {
        this._applyPose(this.lastResponse, this.lastSnapshot);
        Log.info(`[immersal] 규약 → ${c.name} (재정렬 완료)`);
      } else {
        Log.warn(`[immersal] 규약 → ${c.name} (아직 측위 성공 기록이 없어 적용만 예약)`);
      }
      return c.name;
    }

    conventionName() {
      return CONVENTIONS[this.conventionIndex].name;
    }

    /** 서버에 Immersal 설정(.env)이 들어있는지 확인 */
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

    /** 8th Wall 카메라 파이프라인에 캡처 모듈을 등록한다. XR8 로드 후 호출할 것. */
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

    /** 캐시된 휘도 프레임을 padding 제거한 연속 배열로 복사 */
    _packLuminance() {
      const {pixels, cols, rows, rowBytes} = this.frame;
      if (rowBytes === cols) return pixels.subarray(0, cols * rows);
      const out = new Uint8Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        out.set(pixels.subarray(y * rowBytes, y * rowBytes + cols), y * cols);
      }
      return out;
    }

    /**
     * 렌더 투영행렬(intrinsics)에서 캡처 해상도 기준 fx/fy/ox/oy 를 뽑는다.
     * 표준 투영행렬: m[0] = 2·fx/W, m[5] = 2·fy/H, m[8] = 2·ox/W − 1, m[9] = 2·oy/H − 1
     */
    _intrinsics(cols, rows) {
      const m = this.reality && this.reality.intrinsics;
      if (!m || m.length < 10 || !m[0]) {
        // 폴백: 일반적인 모바일 후면 카메라 화각(약 60°) 가정
        const f = cols / (2 * Math.tan((60 * Math.PI / 180) / 2));
        return {fx: f, fy: f, ox: cols / 2, oy: rows / 2, estimated: true};
      }
      const fx = (m[0] * cols) / 2;
      const fy = (m[5] * rows) / 2;
      const ox = ((m[8] + 1) * cols) / 2;
      const oy = ((m[9] + 1) * rows) / 2;
      return {
        fx: Math.abs(fx),
        fy: Math.abs(fy),
        ox: Number.isFinite(ox) ? Math.abs(ox) : cols / 2,
        oy: Number.isFinite(oy) ? Math.abs(oy) : rows / 2,
        estimated: false,
      };
    }

    /** 1회 측위 시도. 성공하면 true. */
    async localizeOnce() {
      if (this.busy) return false;
      if (!this.serverReady) return false;
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

        // 요청 시점의 SLAM 카메라 포즈를 고정해 둔다(응답 지연 동안 카메라가 움직이므로).
        const snapshot = this.reality ? {
          position: {...this.reality.position},
          rotation: {...this.reality.rotation},
        } : null;

        const res = await fetch('/api/immersal/localize', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({b64, fx, fy, ox, oy}),
        });
        const json = await res.json();
        const ms = Math.round(performance.now() - t0);

        if (!res.ok || json.success === false || (json.error && json.error !== 'none')) {
          // error:'none' + success:false = 요청은 정상이나 맵과 매칭 실패 (각도/조명/거리 문제)
          const why = json.error && json.error !== 'none' ? json.error
            : (json.success === false ? '맵과 매칭 안 됨' : res.status);
          Log.warn(`[immersal] 측위 실패(${this.attempts}회, ${ms}ms): ${why}`);
          this.onStatus('fail');
          return false;
        }

        this._applyPose(json, snapshot);
        Log.info(`[immersal] 측위 성공! map=${json.map} conf=${json.confidence ?? '-'} (${ms}ms, ${cols}x${rows})`);
        this.localized = true;
        this.onStatus('ok');
        this.stopAuto();
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

    /**
     * 맵 좌표계 콘텐츠 루트를 SLAM 트래킹 공간에 정렬한다.
     * @param {object} r  Immersal 응답 (px,py,pz, r00..r22)
     * @param {object} snap  요청 시점의 SLAM 카메라 포즈
     */
    _applyPose(r, snap) {
      if (!snap) { Log.warn('[immersal] SLAM 포즈 스냅샷 없음 — 정렬 생략'); return; }
      this.lastResponse = r;
      this.lastSnapshot = snap;

      const c = CONVENTIONS[this.conventionIndex];

      // 응답의 3x3 회전 + 위치. transpose 는 행/열 해석 차이를 흡수한다.
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

      // T_map_cam = pre · M · post
      let T_map_cam = new THREE.Matrix4()
        .multiplyMatrices(c.pre, M)
        .multiply(c.post);
      if (c.invert) T_map_cam = T_map_cam.clone().invert();

      const T_cam_map = new THREE.Matrix4().copy(T_map_cam).invert();

      // T_track_cam : SLAM 트래킹 공간에서의 카메라 포즈
      const T_track_cam = new THREE.Matrix4().compose(
        new THREE.Vector3(snap.position.x, snap.position.y, snap.position.z),
        new THREE.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w),
        new THREE.Vector3(1, 1, 1)
      );

      // T_track_map = T_track_cam · T_cam_map
      const T_track_map = T_track_cam.multiply(T_cam_map);

      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      T_track_map.decompose(pos, quat, scl);

      const o = this.rootEl.object3D;
      o.position.copy(pos);
      o.quaternion.copy(quat);
      o.updateMatrixWorld(true);

      const f = (n) => n.toFixed(2);
      Log.info(`[immersal] 규약 ${c.name} → 루트 pos(${f(pos.x)}, ${f(pos.y)}, ${f(pos.z)})`);

      // 자체 검증: 카메라를 맵 좌표계로 되돌리면 응답의 (px,py,pz) 와 같아야 한다.
      // 여기서 어긋나면 규약이 아니라 계산 자체가 틀린 것이다.
      const camInMap = o.worldToLocal(
        new THREE.Vector3(snap.position.x, snap.position.y, snap.position.z)
      );
      const drift = camInMap.distanceTo(new THREE.Vector3(r.px, r.py, r.pz));
      Log.info(`[immersal] 자체검증 오차 ${drift.toFixed(3)}m ${drift < 0.01 ? '(정상)' : '(⚠ 계산 오류 의심)'}`);
    }

    startAuto({intervalMs, maxAttempts}) {
      this.stopAuto();
      this.timer = setInterval(() => {
        if (this.localized || this.attempts >= maxAttempts) { this.stopAuto(); return; }
        this.localizeOnce();
      }, intervalMs);
    }

    stopAuto() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  }

  window.ImmersalLocalizer = ImmersalLocalizer;
})();
