export interface BrowserTabView {
  id: string
  title: string
  url: string
  active: boolean
}

export interface BrowserStateView {
  running: boolean
  control: 'agent' | 'human'
  activePageId?: string
  tabs: BrowserTabView[]
}

export interface BrowserScreenView extends BrowserStateView {
  image: string
  mediaType: 'image/jpeg'
  width: number
  height: number
}

export interface BrowserSnapshotView {
  snapshotId: string
  pageId: string
  url: string
  title: string
  content: string
}

export interface BrowserActionView {
  pageId: string
  url: string
  title: string
}

export type BrowserRpcEndpoint =
  | 'state'
  | 'screen'
  | 'lease/acquire'
  | 'lease/release'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'tabs/new'
  | 'tabs/select'
  | 'tabs/close'
  | 'pointer/click'
  | 'viewport/resize'
  | 'wheel'
  | 'key'

export interface BrowserUseConfig {
  profile?: string
  headless?: boolean
  executablePath?: string
  noSandbox?: boolean
  viewportWidth?: number
  viewportHeight?: number
  screenshotQuality?: number
  operationTimeoutMs?: number
  humanLeaseTtlMs?: number
}
