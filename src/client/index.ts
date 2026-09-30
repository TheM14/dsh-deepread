import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Complete the settings slot declaration referenced by the upstream chat types.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { errorMessage, type SubmitDeepread } from './models.js'
import { createPanelState } from './store.js'
import { ComposerButton, DeepReadCard, installStyles, clientCss, Panel } from './view.js'

// DeepSeek Harness 0.2.0-rc.2 removed the `current` field from the
// `sessions.list` snapshot; the live "main session" binding now lives on the
// uiSession service (`ctx.uiSession.adapter.current`, whose snapshot's `key`
// is the session id). The composer facade stays addressable through a
// retained session scope via `conversation.input.for(actx)`.
function submitFromContext(ctx: ClientContext): SubmitDeepread {
  return (instruction) => {
    try {
      const currentId = ctx.uiSession.adapter.current.getSnapshot().key
      if (currentId === undefined) return '当前没有打开的会话，请先在对话中打开一个会话'
      const sessionCtx = ctx.sessions.scope(currentId as SessionId)
      if (sessionCtx === undefined) return '精读提交通道不可用，请直接对对话说：请用 deepread 精读 <内容>'
      const input = ctx.conversation.input.for(sessionCtx)
      input.setDraft(instruction)
      input.submit('queue')
      return null
    } catch (error) {
      return errorMessage(error)
    }
  }
}

export const inject = ['slots', 'sessions', 'conversation', 'uiSession'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStyles(clientCss), 'dsh-deepread: styles')
  const submitDeepread = submitFromContext(ctx)
  const panelState = createPanelState()
  const panelFace = {
    hooks: { panelState: panelState.source },
    togglePanel: panelState.actions.togglePanel,
  }

  ctx.slots.inject('shell.overlay', () => {
    return ctx.slots.register({
      name: 'shell.overlay',
      id: 'deepread-panel',
      order: 10,
      label: '精读助手面板',
      inject: () => ({
        ...panelFace,
        closePanel: panelState.actions.closePanel,
        setPanelPosition: panelState.actions.setPanelPosition,
        submitDeepread,
      }),
    }, Panel)
  })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'deepread-composer',
    order: 30,
    label: '精读',
    inject: () => panelFace,
  }, ComposerButton))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'deepread' },
    DeepReadCard,
  ))
}
