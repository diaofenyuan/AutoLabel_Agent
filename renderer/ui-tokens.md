# 基础 UI 令牌与状态契约

这层令牌复用 `styles.css` 中现有浅色/深色主题变量，不改变产品色彩语义。`tokens.css` 提供稳定别名与尺寸阶梯，`foundations.css` 负责跨页面共用的控件状态；页面仍可保留确有需要的紧凑尺寸。

## 令牌用途

- `--color-background` 用于主画布，`--color-panel` / `--color-sidebar` 用于分区表面；`--color-border` 用作控件边界与分隔。
- `--color-text` 与 `--color-muted` 区分正文和辅助信息；`--color-selected` 是选中底色；`--color-accent` 与 `--color-emphasis` 分别用于交互强调和主操作。
- `--color-success`、`--color-warning`、`--color-error` 表达不同结果，不单独依赖颜色；状态文字仍应可读。
- 间距、字号/字重/行高、圆角、阴影、焦点环、控件高度、动效和图层使用同一组 CSS 变量。主题颜色由 `:root[data-theme="dark"]` 原有映射覆盖。

## 组件状态

- `Button` 忙碌时设置 `aria-busy`、禁用重复提交，并隐藏装饰 spinner；`IconButton` 需要明确的可读 `label`。
- 输入控件共用焦点环、禁用外观和 `aria-invalid` 错误边界。错误说明应通过 `aria-describedby` 关联到提示文本。
- `Badge` 的中性/成功/警告/错误语义使用文字加色彩；`StatusDot` 是装饰元素，应与可读状态文字并用。
- `Notice` 默认是静态说明，可选择 `warning` 语气，不作为实时警报播报。
- `InlineError` 默认 `alert/assertive`；不阻断的警告应显式传入 `tone="warning"` 和适合上下文的 `live="polite"` 或 `off`。
- `Loading` 使用 `status/polite`；`ToastMessage` 对普通提示使用 `status/polite`，对阻断错误使用 `alert/assertive`，并提供关闭按钮。
- `Modal` 使用原生模态对话框，Escape/遮罩关闭后由调用处恢复到触发流程。

## 样例与验收

开发模式添加 `?ui-foundations` 可打开组件样例页；该入口由 `import.meta.env.DEV` 限定，不进入生产构建。样例覆盖浅/深色主题、默认/悬停/焦点/按下/禁用/加载/错误/选中、Notice/Badge/StatusDot、Toast、Modal、Empty 和 Loading。
