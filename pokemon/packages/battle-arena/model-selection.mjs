export function selectBattleModels(catalog, defaults, requested = {}) {
  return Object.fromEntries(['A', 'B'].map(seat => {
    const route = requested[seat] ?? defaults[seat].route;
    const model = catalog.find(entry => entry.route === route);
    if (!model) throw new Error('未知或未通过工具验证的模型：' + String(route));
    return [seat, model];
  }));
}
