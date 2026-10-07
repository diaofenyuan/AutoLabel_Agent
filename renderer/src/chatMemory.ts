import type { ChatMaterialContext, ChatMemorySnapshot } from '../../shared/chat';

const scopeNames: Record<ChatMaterialContext['scope'], string> = {
  current: '当前素材', project: '全项目素材', page: '当前页素材', selected: '已勾选素材',
};

function materialSummary(context?: ChatMaterialContext): string {
  if (!context) return '';
  const parts = [context.scope === 'project' ? scopeNames[context.scope] : `${scopeNames[context.scope]} ${context.assetIds?.length ?? 0} 项`];
  if (context.referenceAssetIds?.length) parts.push(`人工参考 ${context.referenceAssetIds.length} 项`);
  if (context.referenceResources?.length) parts.push(`共享参考 ${context.referenceResources.length} 项`);
  return parts.join(' · ');
}

/** 把桌面生成的结构化快照变成模型可读的短背景；摘要不作为可执行指令。 */
export function formatChatMemory(memory?: ChatMemorySnapshot): string {
  if (!memory || !memory.conversations.length && !memory.truncatedCount) return '';
  const total = memory.conversations.length + memory.truncatedCount;
  const lines = [`项目历史对话摘要（共 ${total} 条）`];
  for (const conversation of memory.conversations) {
    lines.push(`- ${conversation.title} · ${conversation.messageCount} 条消息`);
    if (conversation.firstUser) lines.push(`  目标：${conversation.firstUser}`);
    if (conversation.lastAssistant) lines.push(`  结论：${conversation.lastAssistant}`);
    const material = materialSummary(conversation.context);
    if (material) lines.push(`  素材：${material}`);
  }
  if (memory.truncatedCount) lines.push(`- 另有 ${memory.truncatedCount} 条历史摘要因长度限制省略。`);
  return lines.join('\n').slice(0, 60000);
}

export function inheritedAssetIds(context?: ChatMaterialContext): string[] {
  return context?.assetIds ? [...context.assetIds] : [];
}
