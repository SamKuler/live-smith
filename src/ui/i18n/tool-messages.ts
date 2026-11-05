export const toolMessages: Record<string, string> = {
  "Main": "主轨道",
  "Return": "返回轨道",
  "LALAL.AI": "LALAL.AI",
  "ElevenLabs": "ElevenLabs",

  // Tool descriptions use the English text projected into the Session catalog.
  "Inspect the exact Live object used to open this Session, including its current type-specific state. Long collections and parameter lists are paged; follow nextOffset values until the needed item is visible. This does not change the Set.":
    "查看打开此会话的 Live 对象及其当前状态。长列表和参数列表按页返回。根据 nextOffset 继续读取，直到找到所需条目。此操作为只读。",
  "Inspect the Live Set structure, including role-addressable regular, Return, and Main tracks and the names of devices on each track. This does not change the Set.":
    "查看 Live Set 的结构，包括常规轨道、可按角色定位的返回轨道和主轨道，以及各轨道上的设备名称。此操作为只读。",
  "Inspect a regular Track including Clips and devices, or a role-addressed Return/Main Track including its device chain. Use this before editing when the exact device chain is unknown.":
    "查看常规轨道上的片段和设备，或按角色查看返回轨道及主轨道的设备链。编辑前若需确认设备链，可先用此工具查看。",
  "Inspect one existing Take Lane and page its exact MIDI or Audio Clip references. Follow nextOffset until every relevant Clip range has been checked.":
    "查看一条现有录音分轨，分批返回 MIDI 或音频片段的准确引用。根据 nextOffset 继续读取，直到查完相关片段范围。",
  "Inspect a paged list of a Live device's exact exposed parameter names, ranges, current values, defaults, and indexed value items. Follow parameter and value-item nextOffset values until the needed target is visible.":
    "分批查看 Live 设备公开的参数名称、范围、当前值、默认值和带索引的可选值。根据参数或选项列表的 nextOffset 继续读取，直到找到目标。",
  "Inspect a paged top-level or nested device tree, including Rack chains, Drum Rack receiving notes, Simpler sample names, exact device paths, and exposed parameters. Follow nextOffset values for omitted devices, parameters, or value items.":
    "分批查看顶层和嵌套设备结构，包括 Rack 链、Drum Rack 接收的音符、Simpler 采样名称、准确的设备路径及公开参数。根据 nextOffset 查看其余设备、参数或选项。",
  "Inspect one exact existing Rack Chain, including empty Chains, direct device indexes and paths, an optional Drum receiving note, and exact Chain Volume, Panning, and Send values. Direct devices are paged; follow nextOffset until the needed device is visible.":
    "查看 Rack 中指定的一条链，包括空链。返回链内直属设备的索引和路径、鼓组接收音符（如有）以及链的音量、声像和发送值。直属设备按页返回，可根据 nextOffset 继续查找。",
  "Inspect the selected or named Track mixer and return exact Volume, Panning, and Send parameter ranges and current values.":
    "查看所选或指定轨道的混音器，返回音量、声像和发送参数的准确范围及当前值。",
  "Inspect a MIDI or Audio Clip in Arrangement or Session View, including common properties and type-specific notes, warp state, markers, or sample filename. Audio Warp Markers are paged; follow nextOffset until the needed marker is visible. Omit the locator to inspect the selected Clip.":
    "查看编曲视图或会话视图中的 MIDI 或音频片段。返回通用属性，以及音符、Warp 状态、标记或采样文件名等对应类型的属性。音频 Warp 标记按页返回，可根据 nextOffset 继续查找。省略定位信息时查看当前所选片段。",
  "Inspect a MIDI clip and return its exact notes with pitch numbers, note names, start times, durations, and velocities. Use this before judging chord correctness or rewriting MIDI notes.":
    "查看 MIDI 片段的准确音符，包括音高编号、音名、起始位置、时值和力度。可在判断和弦或改写音符前用来核对原始内容。",
  "Render one exact Arrangement Audio Clip beat range as pre-effects audio and return objective sample peak, RMS, crest factor, DC offset, silence, and clipping metrics. This is not realtime listening and does not include the track device chain.":
    "对编曲视图中音频片段的指定拍点范围进行效果处理前渲染，测量采样峰值、均方根电平、峰值因数、直流偏移、静音和削波。此分析使用离线渲染，取样点在轨道设备链之前。",
  "Render one bounded range inside an isolated Arrangement Audio Clip as pre-effects audio and provide it to the next model turn. Use this when the user's request requires hearing or transcribing audio. This does not include the track device chain and is not available for Session View Clips.":
    "渲染编曲视图中单个音频片段的指定范围，把轨道设备处理前的音频提供给模型下一轮读取。适用于需要听辨或转录的任务，仅支持编曲视图中的音频片段。",
  "Inspect song-level settings plus a paged list of zero-based Session View Scene indexes and Arrangement Cue Points. Follow nextOffset until the target Scene or Cue Point is visible.":
    "查看歌曲设置，并分批列出会话视图中从 0 开始编号的场景和编曲视图定位点。根据 nextOffset 继续查找目标场景或定位点。",
  "Propose a batch of Live Set edits. The extension asks once for this batch. Use stable targets/trackRef dependencies inside one batch, or make staged calls when newly created Live state must be inspected. Device names are exact built-in names and are accepted or rejected by the current Live host during execution.":
    "提出一批 Live Set 编辑，审批按批次处理。批内可使用稳定目标或 trackRef 引用。若后续步骤依赖新建对象的实际状态，可分批执行并在中途检查。设备使用准确的内置名称，由当前 Live 宿主在执行时核验。",
  "Ask the user to keep the Live changes already completed and close the active unfinished operation without undoing or performing any Live mutation. Use this only after the required current-request recovery observation when the remaining repair should be abandoned.":
    "请用户确认保留已经完成的 Live 编辑，并结束当前未完成的操作。此操作只结束恢复流程。适用于完成本轮所需的恢复检查后，决定放弃剩余修复的情况。",
  "Propose a complete replacement for this Session's creative brief: style, references, section structure, track roles, and material to keep. This only creates a reviewable suggestion; it NEVER saves preferences or changes Live. The user must review and explicitly save the brief in the Session editor. Do not copy observed BPM, meter, or other Live facts into preferences unless the user states them as creative intent.":
    "为此会话提出完整的创作要求草案，可涵盖风格、参考、段落结构、轨道分工和需保留的素材。草案需要在会话编辑器中由用户审阅并主动保存。用户明确把节拍速度、拍号或其他观察结果指定为创作意图时，再写入创作要求。",
  "List Session-owned MIDI, audio and device-parameter artifacts, including saved outputs whose tool result was not confirmed. Each work marks its primary or newest readable version with defaultForWork; exact artifactRef requests preserve that version. MIDI bytes are verified and unavailable files produce a warning; audio bytes are verified when consumed. Read MIDI with inspect_midi_artifact and parameter snapshots with inspect_device_parameter_artifact. Use create_midi_clip_from_artifact with a listed partId…":
    "列出当前会话的 MIDI、音频和设备参数产物，包括工具结果尚待确认的已保存版本。defaultForWork 标记每个作品的主版本或最新可读版本，指定 artifactRef 可读取对应版本。MIDI 会立即校验，文件不可用时会提示。音频在使用时校验。可用 inspect_midi_artifact 查看 MIDI，用 inspect_device_parameter_artifact 查看参数快照。导入 MIDI 时使用 create_midi_clip_from_artifact，并指定 partId 或明确合并多个声部。参数快照可在产物卡片中比较和应用。此工具只读取会话数据。",
  "Read exact saved MIDI notes for one source part from list_session_artifacts. Notes use source-relative quarter-note beats; channel and source track identity remain in the part summary. Returns at most 256 notes with nextOffset for pagination. Reads this Session only; does not change Live or run a generator.":
    "按 list_session_artifacts 中列出的声部读取已保存的准确 MIDI 音符。音符以相对源文件起点的四分音符拍数表示，声部摘要保留通道和源轨道信息。每页最多返回 256 个音符，可按 nextOffset 继续读取。此工具只读取当前会话。",
  "Save a multitrack MIDI artifact in this Session without changing Live. Supply named tracks, MIDI channels and note timing in quarter-note beats relative to the file start. durationBeats includes trailing silence. To revise a saved artifact, pass its artifactRef as revisionOf; the next-chat source selected by the user is applied automatically. Every revision creates a new immutable version. Use list_session_artifacts and inspect_midi_artifact to read source notes. The user can inspect version changes, expor…":
    "在当前会话中保存多轨 MIDI 产物。填写轨道名、MIDI 通道，以及相对文件起点的四分音符拍数。durationBeats 包含尾部留白。修订已保存的产物时，将其 artifactRef 填入 revisionOf，或沿用用户为下一条消息选定的来源。每次修订都会生成独立版本。可通过 list_session_artifacts 和 inspect_midi_artifact 读取源音符，并在界面中比较版本、导出、附加到消息或导入 Live。",
  "Capture every exposed parameter of one observed Live device into an immutable Session artifact. This reads Live and saves values without changing it. Use an observed devicePath to disambiguate same-name or nested devices. The snapshot contains raw values, ranges and labels, not a complete plugin preset or automation state. Returns an exact artifactRef; inspect it to author a variation.":
    "将一个已观察设备公开的所有参数保存为当前会话中的快照。可用已观察到的 devicePath 区分同名设备或定位嵌套设备。快照保存参数原始值、范围和标签，范围限于公开参数。返回准确的 artifactRef，供读取快照并创建变体。此操作仅从 Live 读取参数。",
  "Read a saved device parameter version from this Session. Returns exact indexes, names, raw values, ranges and enum labels in pages of 64, with nextOffset. Enum labels do not define numeric mappings. Does not observe or change Live.":
    "读取当前会话已保存的设备参数版本。每页最多返回 64 个参数的准确索引、名称、原始值、范围和枚举标签，并返回 nextOffset。枚举标签只用于显示。此操作只读取会话产物。",
  "Save a candidate device parameter version based on an existing captured snapshot. Supply only changed observed parameter indexes, exact names and raw values; all other saved parameters are preserved. The selected next-chat source is inherited; otherwise revisionOf is required. Saving never changes Live. The version is available in Artifacts. When finished sounds are ready for user audition, optionally call present_device_parameter_candidates with the chosen versions.":
    "基于现有快照保存一个设备参数候选版本。填写有变化的参数索引、准确名称和原始值，其余参数沿用快照。优先使用为下一条消息选定的来源，或指定 revisionOf。版本会出现在产物列表中。完成候选音色后，可通过 present_device_parameter_candidates 请用户试听选择。",
  "Offer the user an inline sound-choice card for one device when finished saved sounds are ready to audition or compare. This optional presentation tool displays exactly the supplied Session parameter artifactRefs in order, plus Original for restoring the pre-audition state. Choose one or more versions to suit the conversation; collecting a source snapshot or saving intermediate work alone does not call for a presentation. All versions must belong to the same device and parameter layout. This returns immedia…":
    "为单个设备显示音色选择卡，按指定顺序列出已保存的候选版本，并提供「原始」选项恢复试听前的状态。候选须属于同一设备且参数布局一致。工具返回时只展示卡片。用户点击选项后，Live 仍会检查编辑范围、目标绑定和当前状态。",
};
