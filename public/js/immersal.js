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
  const CV_TO_GL = new THREE.Matrix4().makeScale(1, -1, -1);

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

      // T_map_cam : 맵 좌표계에서의 카메라 포즈 (OpenCV 규약)
      const R = new THREE.Matrix4().set(
        r.r00, r.r01, r.r02, r.px,
        r.r10, r.r11, r.r12, r.py,
        r.r20, r.r21, r.r22, r.pz,
        0, 0, 0, 1
      );
      const T_map_cam = R.multiply(CV_TO_GL);        // → OpenGL 규약으로 변환
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
      Log.info(`[immersal] 루트 정렬: pos(${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
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
