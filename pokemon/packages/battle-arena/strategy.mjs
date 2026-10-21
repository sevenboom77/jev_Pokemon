export const DECISION_POLICY = 'switch-opportunity-cost-v1';

export const PLAYER_STRATEGY = [
  '每次以最新观察的对手当前上场宝可梦、双方血量和已公开技能为依据；不能把未上场的对手当作当前目标，也不能把未知技能或属性当作事实。',
  '主动换人会消耗本回合的攻击、恢复或强化机会，换入者可能立刻承受对手攻击。先比较最佳留场行动与换人的本回合及下一回合收益，不能仅因属性看起来更好就换人。',
  '结合 recentOwnActions 检查刚才为什么换人。若立即换回上一只，必须有具体的新局势或收益；局势未变且留场行动更有收益时继续留场。保护残血、抵抗已公开威胁、处理睡眠等可以是合理收益。',
  '根据 switchReason 区分主动换人、技能触发换人和倒下替补。后两者无需放弃一次新的攻击机会，不应为了减少换人而拖延必要替补。',
  'Jev 是建议，你保留最终决策权。若建议换人但无法解释收益，重新比较合法留场行动。主动换人的中文公开理由须说明实际当前对手、收益及付出的回合成本；只使用工具返回的候选。',
];

export const JEV_STRATEGY = 'Choose the supplied legal action with the best chance of winning this Pokemon singles battle. Use the currently active opponent, current HP/status and publicly revealed moves; do not assume hidden information or target a benched opponent. Compare the best stay-in attack, recovery or setup with switching over this turn and the next. A voluntary switch spends this turn instead of attacking/recovering/setting up, and the incoming Pokemon may immediately take the opponent attack. A type advantage alone is insufficient: weigh damage avoided, survival, status relief and a concrete next-turn benefit against lost tempo. Inspect recentOwnActions before recommending a switch straight back; prefer a productive stay-in action when the situation is unchanged, but allow switching when it improves the winning line. switchReason distinguishes voluntary, pivot and faintReplacement: pivot replacements and replacements after fainting are necessary and do not spend another voluntary-switch turn. Type multiplier is not a win probability.';
