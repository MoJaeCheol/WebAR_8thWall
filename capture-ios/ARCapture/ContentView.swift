import ARKit
import SceneKit
import SwiftUI

struct ContentView: View {
    @StateObject private var cap = CaptureController()

    var body: some View {
        ZStack {
            ARPreview(session: cap.session)
                .ignoresSafeArea()
                .onAppear { cap.run() }

            VStack {
                // 상단 상태
                VStack(spacing: 6) {
                    if !cap.supported {
                        Text("⚠ 이 기기는 LiDAR(sceneDepth)를 지원하지 않습니다")
                            .font(.callout).bold().foregroundColor(.red)
                    }
                    HStack(spacing: 12) {
                        Circle().fill(cap.trackingNormal ? .green : .yellow).frame(width: 10, height: 10)
                        Text(cap.trackingText).font(.callout)
                    }
                    if cap.isRecording {
                        Text("키프레임 \(cap.keyframes)장 · 이동 \(String(format: "%.1f", cap.distance))m")
                            .font(.callout.monospacedDigit())
                        Text("한 바퀴 루프 + 대각 횡단 2회, 80~150장 권장")
                            .font(.caption).opacity(0.8)
                    }
                    if let done = cap.finishedFolder {
                        Text("저장 완료: \(done)").font(.caption)
                        Text("파일 앱 → 나의 iPhone → ARCapture 에서 폴더를 길게 눌러\n\"압축\" 후 PC 로 보내세요 (data/datasets/ 에 풀기)")
                            .font(.caption2).multilineTextAlignment(.center).opacity(0.8)
                    }
                }
                .padding(10)
                .background(.black.opacity(0.55))
                .foregroundColor(.white)
                .cornerRadius(12)
                .padding(.top, 8)

                Spacer()

                // 하단 녹화 버튼
                Button(action: { cap.isRecording ? cap.stop() : cap.start() }) {
                    Text(cap.isRecording ? "캡처 종료" : "캡처 시작")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(cap.isRecording ? Color.red : Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(14)
                }
                .disabled(!cap.supported)
                .padding(.horizontal, 24)
                .padding(.bottom, 18)
            }
        }
    }
}

/// ARSCNView 프리뷰 — 세션은 CaptureController 가 소유한다.
struct ARPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let v = ARSCNView(frame: .zero)
        v.session = session
        v.automaticallyUpdatesLighting = true
        return v
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
