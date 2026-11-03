/**
 * Browser half of the git plugin: the right-sidebar Git panel, and the rows its
 * tools draw in a conversation.
 *
 * The panel is one page type with one guide card, and it talks to this plugin's
 * own authenticated routes — the same functions the tools call — so a panel and
 * a tool call can never report two different branches.
 *
 * The services here are the ones every shell serves. In particular no settings
 * transport is required: a shell that serves none loses nothing, because a git
 * panel reads repositories, not a settings document.
 *
 * @module dsh-git/src/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the right sidebar's Context merge (ctx.sidebarRightTabs) and
// the tab seats this panel registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the Tool layer's SlotMap merge (the 'tool.call.toolview' entry).
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'

import { GIT_TAB_ID, GIT_TAB_KIND } from '../contract.ts'
import { GitIcon, GitPanel, GitPanelTitle, type GitPanelFace } from './GitPanel.tsx'
import { GitPanelController } from './panel.ts'
import { NS, TOOL_NS, en, toolEn, toolZh, zh, type GitLocaleKey, type ToolLocaleKey } from './locales.ts'
import { registerToolRows } from './GitToolRows.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the Git panel. */
    'panel.git': GitLocaleKey
    /** Copy of the tool-call rows this plugin draws. */
    'tool.git': ToolLocaleKey
  }
}

/**
 * The services this half reads, all of which every shipped shell serves.
 *
 * They are required rather than optional because each one owns a surface this
 * plugin exists for: the slot registry, the dictionaries, and the tab type. A
 * shell missing one would be a shell this plugin has nothing to draw in, which
 * is a different situation from a desktop app that serves no settings transport.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Register the panel and the tool rows.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git: panel copy')
  ctx.effect(() => ctx.locale.register(TOOL_NS, { zh: toolZh, en: toolEn }), 'dsh-git: tool row copy')

  registerToolRows(ctx)

  const t = ctx.locale.bind(NS)
  const controller = new GitPanelController()
  // A hot reload replaces this fiber; the reads it started and the listeners the
  // panel added have to go with it, or every reload leaves another controller
  // answering a page that no longer exists.
  ctx.effect(() => () => { controller.dispose() }, 'dsh-git: panel reads')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: GIT_TAB_ID,
    kind: GIT_TAB_KIND,
    title: () => t('panelTitle'),
    guide: [{
      id: GIT_TAB_KIND,
      // After the shipped cards (files, browser, terminal), so a deployment's
      // own entry never pushes the built-in ones around.
      order: 45,
      title: () => t('panelTitle'),
      description: () => t('guideHint'),
      icon: GitIcon,
    }],
  }), 'dsh-git: panel type')

  /**
   * The panel's inject face.
   *
   * Building it starts the reads: the renderer calls this when the tab body
   * mounts, so an install that never opens the panel never runs a git command.
   */
  const face = (): GitPanelFace => {
    controller.start()
    return { hooks: { gitPanel: controller }, git: controller.actions }
  }

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: GIT_TAB_ID, locale: NS, inject: face,
  }, GitPanel)), 'dsh-git: panel body')

  // Registered so the chip follows a language switch; without it the chip keeps
  // the title the registry captured when the tab opened.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: GIT_TAB_ID, locale: NS, inject: face,
  }, GitPanelTitle)), 'dsh-git: panel title')
}
