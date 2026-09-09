// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { Session, type SessionHost } from '@/app/Session'
import { assemblyOf } from '@/genome/assembly'
import { setUpDom } from '../support/dom'

beforeEach(() => {
  setUpDom()
  sessionStorage.clear()
})

const host: SessionHost = {
  sessionChanged: () => {},
  stateChanged: () => {},
  panelsChanged: () => {},
  openFileDialog: () => {},
  openWorkspaceFile: () => {},
  panelLayout: () => ({}) as never,
  applyPanelLayout: () => {},
  notify: () => {},
  activity: () => {},
}

describe('spike', () => {
  it('builds a browser session', () => {
    const session = new Session(host)
    const assembly = assemblyOf({
      uri: 'yeast.bw',
      name: 'yeast.bw',
      contigs: [{ name: 'I', length: 1000 }],
      origin: 'sizes',
    })
    ;(session as unknown as { setUpBrowserAnnotations(a: unknown): void }).setUpBrowserAnnotations(
      assembly,
    )
    const titles = Array.from(session.annotationsHost.querySelectorAll('.card-title')).map(
      (n) => n.textContent,
    )
    console.log('titles', JSON.stringify(titles))
    console.log('html', session.annotationsHost.innerHTML.slice(0, 300))
    expect(titles.length).toBeGreaterThan(0)
  })
})
