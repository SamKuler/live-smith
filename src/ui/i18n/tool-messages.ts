/** User-facing explanations are independent of the model's tool instructions. */
export const liveToolHelp: Readonly<Record<string, readonly [string, string]>> = {
  inspect_current_object: ["View the Live content linked to this conversation.", "查看当前会话关联的 Live 内容。"],
  inspect_live_set: ["View the tracks and devices in the Live Set.", "查看工程中的轨道和设备。"],
  inspect_track: ["View a track and its Clips and devices.", "查看轨道及其片段、设备。"],
  inspect_take_lane: ["View the Clips on a Take Lane.", "查看录音分轨中的片段。"],
  inspect_device: ["View a device's parameters and current settings.", "查看设备的参数及当前设置。"],
  inspect_device_tree: ["Browse devices, Racks and their internal chains.", "查看设备、机架及其内部链路。"],
  inspect_rack_chain: ["View devices and mixer settings within a Rack chain.", "查看机架链中的设备和混音设置。"],
  inspect_mixer: ["View a track's volume, pan and sends.", "查看轨道的音量、声像和发送设置。"],
  inspect_clip: ["View a MIDI or audio Clip's content and playback settings.", "查看 MIDI 或音频片段的内容和播放设置。"],
  inspect_midi_clip: ["View the notes, timing and velocities in a MIDI Clip.", "查看 MIDI 片段中的音符、节奏和力度。"],
  analyze_audio_clip: ["Measure an audio Clip's level and check for clipping, without track effects.", "测量音频片段的电平并检查削波，结果不含轨道效果。"],
  read_arrangement_audio: ["Let the model listen to an Arrangement audio Clip, without track effects.", "让模型听取编曲视图中的音频片段，不包含轨道效果。"],
  inspect_song_info: ["View the song's tempo, meter, Scenes and Arrangement markers.", "查看工程速度、拍号、场景和编曲定位点。"],
  apply_live_actions: ["Make changes in Live using the current approval settings.", "按当前审批设置修改 Live 工程。"],
  resolve_live_recovery: ["Confirm keeping completed changes and finish the interrupted operation.", "确认保留已完成的修改，并结束中断的操作。"],
  propose_creative_brief: ["Draft creative requirements for you to review and save.", "起草创作要求，供你检查和保存。"],
  list_session_artifacts: ["Browse MIDI, audio and device parameter versions saved in this conversation.", "查看当前会话保存的 MIDI、音频和设备参数版本。"],
  inspect_midi_artifact: ["View the parts and notes in a saved MIDI version.", "查看已保存 MIDI 版本的声部和音符。"],
  save_midi_artifact: ["Save a new MIDI version to preview, continue editing or import into Live.", "保存新的 MIDI 版本，供预览、继续创作或导入 Live。"],
  capture_device_parameter_artifact: ["Save a device's readable parameter settings for comparison or restoration.", "保存设备当前可读取的参数，供比较或恢复。"],
  inspect_device_parameter_artifact: ["View the parameter values in a saved version.", "查看已保存版本的参数值。"],
  save_device_parameter_artifact: ["Save a new parameter version for auditioning in Live.", "保存新的参数版本，供在 Live 中试听。"],
  present_device_parameter_candidates: ["Show saved sound versions for auditioning and comparison.", "显示已保存的音色候选，供试听和比较。"],
};

export const toolMessages: Record<string, string> = {
  Main: "主轨道", Return: "返回轨道", "LALAL.AI": "LALAL.AI", ElevenLabs: "ElevenLabs",
  ...Object.fromEntries(Object.values(liveToolHelp)),
};
