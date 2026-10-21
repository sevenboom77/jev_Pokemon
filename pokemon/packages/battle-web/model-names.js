// Presentation names only. Never substitute these strings in provider requests.
export const MODEL_DISPLAY_NAMES = Object.freeze({
  'agnes-3.0-flash': 'AGNES-3.0-Flash',
  'deepseek-flash': 'DeepSeek-V4.1-Flash',
  'glm-5.3': 'GLM-5.3',
  'Kimi-K3-bingxing': 'Kimi-K3',
  'Kimi-K3': 'Kimi-K3',
  'kimi-k3': 'Kimi-K3',
  'official-kimi-k3': 'Kimi-K3',
  'mimo-v2.6-pro': 'MiMo-V2.6-Pro',
  'minimax-m3': 'MiniMax-M3',
  'qwen3.8-max-0902': 'Qwen3.8-Max-0902',
  'gemini-3.8-flash-high': 'Gemini-3.8-Flash-High',
  'gpt-5.6-terra-bingxing': 'GPT-5.6-Terra',
  'claude-opus-5-5-high': 'Claude-Opus-5.5-High',
  'claude-opus-4-8': 'Claude-Opus-4.8',
});

export function displayModelName(model) {
  if (typeof model === 'string') return MODEL_DISPLAY_NAMES[model] ?? model;
  return MODEL_DISPLAY_NAMES[model?.model] ?? model?.displayName ?? model?.model ?? model?.label ?? '';
}

export function modelForDisplay(model) {
  return { ...model, displayName: displayModelName(model), label: displayModelName(model) };
}

// Rename rendered trainer labels without changing archived simulator events.
export function displayBattleLines(lines, data) {
  const names = Object.fromEntries(['A', 'B'].map(seat => [seat, displayModelName(data.models?.[seat]) + ' · ' + seat]));
  return lines.filter(line => !line.startsWith('|debug|')).map(line => {
    const fields = line.split('|');
    if (fields[1] === 'player' && ['p1', 'p2'].includes(fields[2])) fields[3] = names[fields[2] === 'p1' ? 'A' : 'B'];
    if (fields[1] === 'win') {
      const seat = ['A', 'B'].find(s => fields[2] === data.playerNames?.[s]);
      if (seat) fields[2] = names[seat];
    }
    return fields.join('|');
  });
}
