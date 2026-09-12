export default function TemplateRuleSummary({ settings }: { settings?: Record<string, unknown> }) {
  const rules = [['rules', '标注规则'], ['occlusionRules', '遮挡规则'], ['blurRules', '模糊规则']].filter(([key]) => settings?.[key] !== undefined && settings[key] !== '');
  return rules.length ? <details className="template-rule-summary"><summary>查看当前模板规则</summary>{rules.map(([key, title]) => <section key={key}><strong>{title}</strong>{typeof settings![key] === 'string' ? <p>{String(settings![key])}</p> : <pre>{JSON.stringify(settings![key], null, 2)}</pre>}</section>)}</details> : null;
}
