// @dev-feature curate
import { describe, it } from 'vitest'
import { testContext } from '../support/curateStage'

describe('probe', () => {
  it('prints the community answer', async () => {
    const { model } = testContext()
    await model.settled()
    const a = model.answer!
    console.log('genomes', a.genomes.map((g) => `${g.id}:${g.kind}:${g.length}`))
    console.log('order', model.order)
    console.log('links', JSON.stringify(a.links))
    console.log('hosts', JSON.stringify(a.hosts))
    console.log('pairs', Array.from(a.pairs.a), Array.from(a.pairs.b), Array.from(a.pairs.affinity))
    console.log('offered', model.offered().map((s) => `${s.key} ${s.confidence.toFixed(3)} ${JSON.stringify(s.genomes)}`))
    console.log('queue', model.queue().map((q) => `${q.key} ${q.members.length}`))
  })
})
