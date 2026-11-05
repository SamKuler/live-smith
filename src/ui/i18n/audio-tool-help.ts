/** Short explanations for people browsing built-in audio tools. */
export const audioToolHelp: Readonly<Record<string, readonly [string, string]>> = {
  add_instrumental: ["Create an instrumental version from the selected song.", "根据选定歌曲生成伴奏版本。"],
  add_vocals: ["Add vocals to the selected instrumental.", "为选定伴奏添加人声。"],
  cover_music: ["Create a new interpretation of the selected audio.", "根据选定音频生成改编版本。"],
  extend_music: ["Generate a continuation from a selected point in the song.", "从歌曲的指定位置生成后续段落。"],
  extract_music_stems: ["Extract separate tracks from the selected song.", "从选定歌曲中提取独立音轨。"],
  finish_music_replacement: ["Save the result of an existing song section replacement.", "保存已有的歌曲段落替换结果。"],
  generate_lyrics: ["Write lyrics from a description without generating audio.", "根据描述创作歌词，输出为文本。"],
  generate_music: ["Generate music from a description or lyrics. This can use the selected connection’s paid allowance.", "根据描述或歌词生成音乐。此操作可能消耗所选连接的付费额度。"],
  generate_song_from_lyrics: ["Generate a song using the supplied lyrics.", "使用提供的歌词生成歌曲。"],
  generate_sound_effect: ["Generate a sound effect from a description.", "根据描述生成音效。"],
  generate_sound_sample: ["Generate an audio sample from a description.", "根据描述生成声音素材。"],
  get_whole_song: ["Combine a song and its continuation into one audio result.", "将歌曲及其续写段落合并为一条音频。"],
  inspect_lyric_models: ["List the models available for writing lyrics.", "列出可用于创作歌词的模型。"],
  inspect_music_service: ["Check available music models and account allowances.", "查看可用的音乐模型和账户额度。"],
  list_audio_jobs: ["Browse audio jobs and saved results from this Session.", "查看当前会话的音频任务和已保存结果。"],
  listen_to_audio_asset: ["Let an audio-capable model listen to one result already saved in this Session.", "让支持音频输入的模型听取此会话中一条已保存的音频结果。"],
  remaster_music: ["Create a remastered version of the selected song.", "为选定歌曲生成重制版本。"],
  replace_music_section: ["Generate a replacement for a selected section of the song.", "为选定歌曲段落生成替换内容。"],
  resume_audio_job: ["Recover an existing audio job or retrieve its missing results. This keeps the original task.", "恢复已有音频任务或取回缺失结果，沿用原任务。"],
  retrieve_music: ["Look up songs saved in the connected music account.", "查找已连接音乐账户中保存的歌曲。"],
  separate_stems: ["Split the chosen audio into separate stems.", "将选定音频拆分为独立音轨。"],
  upload_music: ["Upload the chosen audio for use by tools in this connection.", "上传选定音频，供此连接中的工具使用。"],
  write_lyrics: ["Write lyrics from a description without generating audio.", "根据描述创作歌词，输出为文本。"],
};

export const audioToolHelpMessages = Object.fromEntries(Object.values(audioToolHelp));
