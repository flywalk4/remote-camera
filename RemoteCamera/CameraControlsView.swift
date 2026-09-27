import SwiftUI

/// Manual settings panel on the iPhone screen: lens, ISO, shutter speed, focus.
/// The same settings are available in the Mac remote — they stay in sync.
struct CameraControlsView: View {
    @EnvironmentObject private var model: AppModel

    // Slider values while a finger is on the slider (otherwise state polling would overwrite them).
    @State private var editing: String?
    @State private var isoPos = 0.0
    @State private var shutterPos = 0.0
    @State private var focusPos = 0.0

    var body: some View {
        if let s = model.cameraState, s.maxISO > 0 {
            VStack(alignment: .leading, spacing: 10) {
                if s.lenses.count > 1 {
                    Picker("Lens", selection: Binding(
                        get: { s.lens },
                        set: { id in model.apply { $0.lens = id } }
                    )) {
                        ForEach(s.lenses.sorted { $0.factor < $1.factor }, id: \.id) { lens in
                            Text(Self.factor(lens.factor)).tag(lens.id)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                HStack {
                    Text("Exposure").font(.subheadline.weight(.semibold))
                    Spacer()
                    modePicker(s.exposureMode) { mode in model.apply { $0.exposureMode = mode } }
                }

                sliderRow(
                    title: "ISO",
                    value: editing == "iso" ? Self.fromLog(isoPos, s.minISO, s.maxISO) : s.iso,
                    text: { "\(Int($0.rounded()))" },
                    position: $isoPos,
                    key: "iso",
                    current: Self.toLog(s.iso, s.minISO, s.maxISO)
                ) { pos in
                    let iso = Self.fromLog(pos, s.minISO, s.maxISO)
                    model.apply { $0.iso = iso }
                }

                sliderRow(
                    title: "Shutter",
                    value: editing == "shutter" ? Self.fromLog(shutterPos, s.minShutter, s.maxShutter) : s.shutter,
                    text: Self.shutterText,
                    position: $shutterPos,
                    key: "shutter",
                    current: Self.toLog(s.shutter, s.minShutter, s.maxShutter)
                ) { pos in
                    let shutter = Self.fromLog(pos, s.minShutter, s.maxShutter)
                    model.apply { $0.shutter = shutter }
                }

                HStack {
                    Text("Focus").font(.subheadline.weight(.semibold))
                    Spacer()
                    modePicker(s.focusMode) { mode in model.apply { $0.focusMode = mode } }
                        .disabled(!s.manualFocusSupported)
                }

                sliderRow(
                    title: "Lens position",
                    value: editing == "focus" ? focusPos : s.lensPosition,
                    text: { String(format: "%.3f", $0) },
                    position: $focusPos,
                    key: "focus",
                    current: s.lensPosition
                ) { pos in
                    model.apply { $0.lensPosition = pos }
                }
                .disabled(!s.manualFocusSupported)

                if s.exposureMode == "auto" {
                    Text("ISO and shutter are currently chosen by the iPhone. Move a slider to switch to manual.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        } else {
            Text(model.cameraState?.error ?? "Starting camera…")
                .font(.subheadline)
                .padding(14)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private func modePicker(_ mode: String, onChange: @escaping (String) -> Void) -> some View {
        Picker("", selection: Binding(get: { mode }, set: onChange)) {
            Text("Auto").tag("auto")
            Text("Manual").tag("manual")
        }
        .pickerStyle(.segmented)
        .frame(width: 140)
    }

    private func sliderRow(
        title: String,
        value: Double,
        text: @escaping (Double) -> String,
        position: Binding<Double>,
        key: String,
        current: Double,
        onChange: @escaping (Double) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.footnote).foregroundStyle(.secondary)
                Spacer()
                Text(text(value)).font(.footnote.monospacedDigit().weight(.semibold))
            }
            Slider(
                value: Binding(
                    get: { editing == key ? position.wrappedValue : current },
                    set: { newValue in
                        position.wrappedValue = newValue
                        onChange(newValue)
                    }
                ),
                in: 0...1,
                onEditingChanged: { active in
                    if active {
                        position.wrappedValue = current
                        editing = key
                    } else if editing == key {
                        editing = nil
                    }
                }
            )
        }
    }

    // Logarithmic scale: equal slider steps = equal exposure stops.
    static func toLog(_ value: Double, _ min: Double, _ max: Double) -> Double {
        guard min > 0, max > min, value > 0 else { return 0 }
        return clamp(log(value / min) / log(max / min), 0, 1)
    }

    static func fromLog(_ pos: Double, _ min: Double, _ max: Double) -> Double {
        guard min > 0, max > min else { return min }
        return min * pow(max / min, pos)
    }

    static func shutterText(_ seconds: Double) -> String {
        guard seconds > 0 else { return "—" }
        if seconds >= 0.95 { return String(format: "%.1f s", seconds) }
        return "1/\(Int((1 / seconds).rounded()))"
    }

    static func factor(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))×" : String(format: "%.1f×", value)
    }
}
