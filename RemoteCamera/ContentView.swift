import AVFoundation
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showControls = true

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraPreview(session: model.camera.session)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                infoCard
                Spacer()
                if showControls {
                    CameraControlsView()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                HStack(spacing: 24) {
                    Button {
                        withAnimation { showControls.toggle() }
                    } label: {
                        Label("Настройки", systemImage: "slider.horizontal.3")
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(showControls ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Material.ultraThinMaterial), in: Capsule())
                    }
                    Button {
                        model.dimmed = true
                    } label: {
                        Image(systemName: "moon.fill")
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.ultraThinMaterial, in: Capsule())
                    }
                    Button(action: model.quickCapture) {
                        Circle()
                            .fill(.white)
                            .frame(width: 68, height: 68)
                            .overlay(Circle().stroke(.gray, lineWidth: 4).padding(-6))
                    }
                    .accessibilityLabel("Снять")
                }
                .padding(.bottom, 12)
            }
            .padding()

            if model.dimmed {
                Color.black
                    .ignoresSafeArea()
                    .overlay(
                        Text("Нажмите, чтобы включить экран")
                            .font(.footnote)
                            .foregroundStyle(Color(white: 0.15))
                    )
                    .onTapGesture { model.dimmed = false }
            }
        }
        .foregroundStyle(.white)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .statusBarHidden(model.dimmed)
    }

    private var infoCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Откройте пульт на Mac:")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if model.urls.isEmpty {
                Text("Нет сети. Подключитесь к Wi-Fi или включите «Режим модема».")
                    .font(.subheadline)
            }
            ForEach(model.urls, id: \.self) { url in
                Text(url)
                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
            }
            if let error = model.serverError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// Превью камеры на экране iPhone.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
