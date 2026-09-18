/**
 * 常用服务商预设：把「基础地址填什么、协议选哪个」这两个新人最容易被卡住的问题直接填好。
 *
 * 这里只写服务商公开文档里稳定的两项——OpenAI 兼容基础地址与协议，不预置任何模型名：
 * 模型清单由「读取模型列表」从用户自己的接口取回，能力也必须由用户点过验证才算数，
 * 猜一个模型名反而会让人以为「选好了」却卡在图片输入这一关。
 */
export interface ProviderPreset {
  id: string;
  label: string;
  note: string;
  baseUrl: string;
  protocol: 'chat-completions' | 'responses';
  /** 接口名称的预填值；留空表示让用户自己命名（自定义这一档）。 */
  name: string;
  keyHint: string;
}

export const providerPresets: ProviderPreset[] = [
  { id: 'custom', label: '自定义', note: '自己填地址', baseUrl: '', protocol: 'chat-completions', name: '', keyHint: '按服务商文档填写' },
  { id: 'openai', label: 'OpenAI', note: '官方接口', baseUrl: 'https://api.openai.com/v1', protocol: 'chat-completions', name: 'OpenAI', keyHint: 'sk- 开头' },
  { id: 'deepseek', label: 'DeepSeek', note: '官方接口', baseUrl: 'https://api.deepseek.com/v1', protocol: 'chat-completions', name: 'DeepSeek', keyHint: 'sk- 开头' },
  { id: 'dashscope', label: '通义千问', note: '阿里云百炼兼容模式', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'chat-completions', name: '通义千问', keyHint: 'sk- 开头' },
  { id: 'zhipu', label: '智谱 GLM', note: '官方接口', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'chat-completions', name: '智谱 GLM', keyHint: '形如 id.secret' },
  { id: 'moonshot', label: '月之暗面', note: 'Kimi 官方接口', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'chat-completions', name: '月之暗面', keyHint: 'sk- 开头' },
  { id: 'siliconflow', label: '硅基流动', note: '聚合开源模型', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'chat-completions', name: '硅基流动', keyHint: 'sk- 开头' },
  { id: 'ollama', label: '本地 Ollama', note: '本机运行，不用密钥', baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat-completions', name: '本地 Ollama', keyHint: '本地服务通常留空' },
];

export function presetById(id: string): ProviderPreset | undefined {
  return providerPresets.find(item => item.id === id);
}
