import ARKit
import Combine
import UIKit

/// LiDAR 캡처 코어.
///
/// 키프레임마다 저장하는 것 (전부 "같은 ARFrame" 에서 나온 한 세트):
///   - RGB JPEG (센서 landscape 방향, 보통 1920×1440)
///   - LiDAR 깊이 Float32 raw (256×192, 카메라 z-깊이, 미터, little-endian)
///   - 깊이 confidence UInt8 raw (0/1/2 = low/med/high)
///   - camera.transform → row-major 16개 (T_world_cam, GL 규약 — ARKit 그대로)
///   - camera.intrinsics (RGB 해상도 기준 fx/fy/cx/cy)
///
/// 산출물은 PC 파이프라인(vps/)의 manifest.json 형식 그대로다 — 변환 단계 없음.
final class CaptureController: NSObject, ObservableObject, ARSessionDelegate {
    let session = ARSession()

    @Published var supported = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    @Published var isRecording = false
    @Published var keyframes = 0
    @Published var trackingText = "초기화 중"
    @Published var trackingNormal = false
    @Published var distance: Float = 0
    @Published var finishedFolder: String? = nil

    // 키프레임 채택 조건
    private let minTranslation: Float = 0.15          // m
    private let minRotation: Float = 12 * .pi / 180   // rad
    private let minInterval: TimeInterval = 0.25      // s

    private var lastPose: simd_float4x4?
    private var lastTime: TimeInterval = 0
    private var frames: [[String: Any]] = []
    private var dir: URL?
    private let io = DispatchQueue(label: "capture.io", qos: .userInitiated)
    private let ciContext = CIContext()

    func run() {
        guard supported else { return }
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity          // Y-up 보장 (manifest 규약)
        config.frameSemantics = [.sceneDepth]
        session.delegate = self
        session.run(config)
    }

    func start() {
        let name = Self.timestampName()
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: base.appendingPathComponent("frames"),
                                                 withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: base.appendingPathComponent("depth"),
                                                 withIntermediateDirectories: true)
        dir = base
        frames = []
        keyframes = 0
        distance = 0
        lastPose = nil
        finishedFolder = nil
        isRecording = true
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func stop() {
        isRecording = false
        UIApplication.shared.isIdleTimerDisabled = false
        guard let dir = dir else { return }
        let name = dir.lastPathComponent
        let manifest: [String: Any] = [
            "version": 1,
            "name": name,
            "source": "arkit-lidar",
            "units": "meters",
            "axes": "gl-yup-rh; pose=T_world_cam row-major; camera looks -Z",
            "intrinsicsReliability": "device-reported",
            "created": ISO8601DateFormatter().string(from: Date()),
            "frames": frames,
        ]
        let framesSnapshot = frames
        io.async {
            if let data = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted]) {
                try? data.write(to: dir.appendingPathComponent("manifest.json"))
            }
            DispatchQueue.main.async {
                self.finishedFolder = "\(name) — 키프레임 \(framesSnapshot.count)장"
            }
        }
    }

    // MARK: - ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        updateTrackingText(frame.camera.trackingState)
        guard isRecording,
              case .normal = frame.camera.trackingState,
              let sceneDepth = frame.sceneDepth,
              let dir = dir else { return }

        let T = frame.camera.transform
        let t = frame.timestamp
        if let last = lastPose {
            let dp = simd_length(T.columns.3.xyz - last.columns.3.xyz)
            let dr = Self.rotationAngle(from: last, to: T)
            if dp < minTranslation && dr < minRotation { return }
            if t - lastTime < minInterval { return }
            distance += dp
        }
        lastPose = T
        lastTime = t

        // 버퍼는 ARKit 이 재사용하므로 이 콜백 안에서 전부 복사한다
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent),
              let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.9) else { return }
        let depthData = Self.copyPixelBuffer(sceneDepth.depthMap, bytesPerPixel: 4)
        let confData = sceneDepth.confidenceMap.map { Self.copyPixelBuffer($0, bytesPerPixel: 1) }
        let dw = CVPixelBufferGetWidth(sceneDepth.depthMap)
        let dh = CVPixelBufferGetHeight(sceneDepth.depthMap)

        let idx = keyframes
        keyframes += 1
        let intr = frame.camera.intrinsics
        let res = frame.camera.imageResolution
        var entry: [String: Any] = [
            "image": String(format: "frames/%06d.jpg", idx),
            "depth": String(format: "depth/%06d.f32", idx),
            "depthSize": [dw, dh],
            "pose": Self.rowMajor(T),
            "intrinsics": [
                "fx": intr.columns.0.x, "fy": intr.columns.1.y,
                "cx": intr.columns.2.x, "cy": intr.columns.2.y,
                "width": Int(res.width), "height": Int(res.height),
            ],
            "t": t,
            "rotOnly": false,
        ]
        entry["depthConfidence"] = confData != nil ? String(format: "depth/%06d.conf", idx) : NSNull()
        frames.append(entry)

        io.async {
            try? jpeg.write(to: dir.appendingPathComponent(String(format: "frames/%06d.jpg", idx)))
            try? depthData.write(to: dir.appendingPathComponent(String(format: "depth/%06d.f32", idx)))
            if let conf = confData {
                try? conf.write(to: dir.appendingPathComponent(String(format: "depth/%06d.conf", idx)))
            }
        }
    }

    private func updateTrackingText(_ state: ARCamera.TrackingState) {
        let (text, ok): (String, Bool)
        switch state {
        case .normal: (text, ok) = ("트래킹 정상", true)
        case .notAvailable: (text, ok) = ("트래킹 불가", false)
        case .limited(.initializing): (text, ok) = ("초기화 중 — 천천히 움직이세요", false)
        case .limited(.excessiveMotion): (text, ok) = ("너무 빠름 — 천천히", false)
        case .limited(.insufficientFeatures): (text, ok) = ("특징 부족 — 다른 곳을 비추세요", false)
        case .limited(.relocalizing): (text, ok) = ("재측위 중", false)
        case .limited: (text, ok) = ("트래킹 제한됨", false)
        }
        if text != trackingText {
            DispatchQueue.main.async {
                self.trackingText = text
                self.trackingNormal = ok
            }
        }
    }

    // MARK: - 유틸

    /// simd_float4x4(column-major) → row-major 16개. m[row][col] = columns[col][row].
    static func rowMajor(_ m: simd_float4x4) -> [Float] {
        (0..<4).flatMap { r in (0..<4).map { c in m[c][r] } }
    }

    static func rotationAngle(from a: simd_float4x4, to b: simd_float4x4) -> Float {
        let ra = simd_float3x3(a.columns.0.xyz, a.columns.1.xyz, a.columns.2.xyz)
        let rb = simd_float3x3(b.columns.0.xyz, b.columns.1.xyz, b.columns.2.xyz)
        let rel = ra.transpose * rb
        let tr = rel.columns.0.x + rel.columns.1.y + rel.columns.2.z
        return acos(max(-1, min(1, (tr - 1) / 2)))
    }

    /// CVPixelBuffer → 패딩 제거된 raw Data (row-major, little-endian).
    static func copyPixelBuffer(_ buf: CVPixelBuffer, bytesPerPixel: Int) -> Data {
        CVPixelBufferLockBaseAddress(buf, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
        let w = CVPixelBufferGetWidth(buf)
        let h = CVPixelBufferGetHeight(buf)
        let rowBytes = CVPixelBufferGetBytesPerRow(buf)
        let src = CVPixelBufferGetBaseAddress(buf)!
        var out = Data(capacity: w * h * bytesPerPixel)
        for y in 0..<h {
            out.append(Data(bytes: src + y * rowBytes, count: w * bytesPerPixel))
        }
        return out
    }

    static func timestampName() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd_HHmmss"
        return "cap_" + f.string(from: Date())
    }
}

extension simd_float4 {
    var xyz: simd_float3 { simd_float3(x, y, z) }
}
