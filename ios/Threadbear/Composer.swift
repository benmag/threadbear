import SwiftUI
import ThreadbearKit

/// The text box at the bottom of a thread: type or dictate, add or paste
/// photos, pick the model, then send. The words sit in the box on top; a
/// row under it holds "+" and the model picker on the left, the mic and
/// Send on the right (Ben's mock-up, 9 Nov).
struct Composer: View {
    @Environment(AppModel.self) private var model
    @Binding var text: String
    var placeholder: String
    /// The thread it replies into: its links fill the row over the box and
    /// its provider and model fill the picker.
    var thread: PhoneThread
    /// Picking a model (nil is the runner's default) updates the thread.
    var onPickModel: (String?) -> Void
    /// Returns whether it went, so a failed send keeps the text.
    var onSend: (String, [PickedPhoto]) async -> Bool
    @State private var photos: [PickedPhoto] = []
    @State private var adding = 0
    @State private var cursor = TextCursor()
    @State private var sending = false
    @State private var dictation = Dictation()

    /// Each photo a chip in the words where it was put in, as on the Mac.
    private var words: PhotoWords { PhotoWords(text: $text, photos: $photos, adding: $adding, cursor: cursor) }

    var body: some View {
        VStack(spacing: 8) {
            let links = thread.links ?? []
            if !links.isEmpty {
                LinkChips(links: links)
            }
            if !photos.isEmpty || adding > 0 {
                PhotoStrip(words: words).disabled(sending)
            }
            DictationNotes(dictation: dictation)
                .frame(maxWidth: .infinity, alignment: .leading)
            // The words and the controls share one box, the words on top
            // (Ben's mock-up, 9 Nov).
            VStack(spacing: 8) {
                // What's typed (or Apple's dictation typing as it goes) stays
                // in sight above the controls.
                field.disabled(sending)
                HStack(alignment: .center, spacing: 8) {
                if hearing {
                    // While it's hearing, the waveform takes the controls' row
                    // and carries its stop, as squeezed beside the text it was
                    // too cramped to read (Mike, 7 Nov).
                    ComposerListeningBar(dictation: dictation)
                } else {
                    if model.canSendPhotos {
                        PhotoMenu(words: words) {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(.secondary)
                                .frame(width: 30, height: 30)
                                .background(Color(.tertiarySystemFill), in: Circle())
                        }
                        // A menu's label takes the accent otherwise, and only Send should have it.
                        .tint(.secondary)
                        .accessibilityLabel("Add a photo")
                    }
                    ModelPill(thread: thread, choices: choices, onPick: onPickModel)
                    Spacer(minLength: 0)
                    // Grey like Add a photo, as only Send has the accent; red while listening.
                    DictateButton(text: $text, dictation: dictation, idleTint: .secondary) {
                        Image(systemName: "mic")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 30, height: 30)
                            .background(Color(.tertiarySystemFill), in: Circle())
                    }
                    .accessibilityLabel(dictation.isListening ? "Stop dictating" : "Dictate")
                }
                Button(action: send) {
                    // A photo can take a while to go up on mobile data.
                    if sending && !photos.isEmpty {
                        ProgressView().frame(width: 30, height: 30)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.black)
                        .frame(width: 34, height: 34)
                        .background(.white, in: Circle())
                        .opacity(canSend ? 1 : 0.4)
                }
                }
                // Not with a photo still on its way, which would be left behind.
                // Nor with Whisper still to type out what was said.
            .disabled(!canSend)
            .accessibilityLabel("Send")
                }
                // Nothing more in while it goes: the box empties when it lands,
                // taking anything added meanwhile with it (Mike, 7 Nov).
                .disabled(sending)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .disabled(sending)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .onDisappear { dictation.close() }
        #if DEBUG
        // For sim-shots.sh: stills of the dictating bar, as the simulator has no one talking.
        .task {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-ThreadbearDictating") { dictation.fakeListening() }
            if args.contains("-ThreadbearTypingOut") { dictation.fakeTypingOut() }
        }
        #endif
        .task {
            if photos.isEmpty, let load = model.loadSamplePhoto { words.add([load], model: model) }
        }
    }

    private var hearing: Bool { dictation.isListening || dictation.isTranscribing }

/// Not while a photo is still on its way, which would be left behind, nor
/// with Whisper still to type out what was said.
private var canSend: Bool {
    !(words.message.isEmpty && photos.isEmpty) && !sending && adding == 0 && !dictation.holdsWords
}

    /// The models this thread can run on, for the picker.
    private var choices: [PhoneModelChoice] { model.threadModels(for: thread) }

    private var field: some View {
        PastableTextField(text: $text, placeholder: placeholder, lines: 1...6,
                          onPasteImages: model.canSendPhotos ? { words.addPasted($0, model: model) } : nil,
            photos: $photos, cursor: cursor, threadReference: { model.threadReference(pasted: $0) })
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }

    private func send() {
        let message = words.message
        guard !message.isEmpty || !photos.isEmpty else { return }
        // Apple's dictation still listening would type into the emptied box.
        dictation.stop()
        sending = true
        Task {
            if await onSend(message, photos) {
                text = ""
                photos = []
            }
            sending = false
        }
    }
}

/// The model picker: a pill reading the thread's model ("Auto" for the
/// runner's default), opening a menu of the models this thread can run
/// on. Only its own provider's models are offered; another provider's
/// would move the thread's login, which the phone doesn't do.
private struct ModelPill: View {
    @Environment(AppModel.self) private var model
    var thread: PhoneThread
    var choices: [PhoneModelChoice]
    var onPick: (String?) -> Void

    private var selected: String { thread.model ?? "" }
    private var title: String {
        guard !selected.isEmpty else { return "Auto" }
        return choices.first { $0.id == selected }?.title ?? selected
    }

    var body: some View {
        // An older backend rejects a model change (phone:update, API 61), so
        // the pill is there to read but can't be picked.
        if model.canChangeModel {
            Menu {
                Picker("Model", selection: Binding(get: { selected }, set: { onPick($0.isEmpty ? nil : $0) })) {
                    Text("Auto").tag("")
                    ForEach(choices) { Text($0.title).tag($0.id) }
                }
            } label: {
                pill
            }
            .accessibilityLabel("Model: \(title)")
        } else {
            pill
                .opacity(0.5)
                .accessibilityLabel("Model: \(title). Update Threadbear on your Mac to change it.")
        }
    }

    private var pill: some View {
        HStack(spacing: 5) {
                Image("Rocket")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 14, height: 14)
                    .foregroundStyle(.secondary)
            Text(title)
                .font(.subheadline)
                .lineLimit(1)
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 30)
        .background(Color(.tertiarySystemFill), in: Capsule())
    }
}

/// A thread's patch link buttons: each opens its page in the browser here,
/// with nothing sent to the Mac. A row that scrolls sideways when there are
/// more than fit.
struct LinkChips: View {
    var links: [PhoneLink]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                    if let page = link.page {
                        Link(destination: page) {
                            Label(link.title, systemImage: UIImage(systemName: link.icon ?? "") == nil ? "arrow.up.right.square" : link.icon!)
                                .font(.footnote)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                        .tint(.primary)
                        .accessibilityHint("Opens \(page.host() ?? "the page") in the browser")
                    }
                }
            }
        }
        .scrollClipDisabled()
    }
}

/// The reply box while dictating: the waveform across the box, the time so
/// far and a stop, or Whisper typing it out once stopped.
private struct ComposerListeningBar: View {
    let dictation: Dictation

    var body: some View {
        // Not a disabled button while typing out: that dims it past reading.
        if dictation.isTranscribing {
            HStack(spacing: 12) {
                ProgressView()
                Text("Typing it out").foregroundStyle(.secondary)
                Spacer()
            }
            .modifier(BarShape())
            .accessibilityElement(children: .combine)
        } else {
            Button { dictation.finish() } label: {
                HStack(spacing: 12) {
                    TimelineView(.periodic(from: .now, by: 1.0 / 15)) { context in
                        HStack(spacing: 12) {
                            Waveform(levels: dictation.level.history)
                            Text(elapsed(at: context.date)).monospacedDigit()
                        }
                    }
                    Image(systemName: "stop.circle.fill").font(.system(size: 26))
                }
                .foregroundStyle(.red)
                .modifier(BarShape())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop dictating")
        }
    }

    private func elapsed(at now: Date) -> String {
        let seconds = Int(now.timeIntervalSince(dictation.startedAt ?? now))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// The bar's box, the same size and shape as the text box it stands in for.
private struct BarShape: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.leading, 14)
            .padding(.trailing, 6)
            .frame(minHeight: 40)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

/// The mic's last moments as bars spread across the width they're given.
private struct Waveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(levels.enumerated()), id: \.offset) { index, value in
                if index > 0 { Spacer(minLength: 2) }
                Capsule().frame(width: 3, height: 3 + CGFloat(value) * 20)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24)
        .animation(.linear(duration: 1.0 / 15), value: levels)
    }
}
