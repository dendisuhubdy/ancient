import axios from 'axios'
import * as hilbertCurve from 'hilbert-curve'
import _ from 'lodash'
import pako from 'pako'
import * as tf from '@tensorflow/tfjs'

let model
;(async () => {
  model = await tf.loadLayersModel(
    `${process.env.baseUrl}tfjs_artifacts/model.json`
  )
})()

const order = 7
// TODO possible to store this in model?
const modelClassNames = [
  { value: 'AFR', label: 'Africa' },
  { value: 'AMR', label: 'America' },
  { value: 'EAS', label: 'East Asia' },
  { value: 'EUR', label: 'Europe' },
  { value: 'SAS', label: 'South Asia' }
]

addEventListener('message', async event => {
  const { file, snps } = event.data

  let data
  if (typeof file === 'string') {
    const res = await axios.get(`${process.env.baseUrl}${file}`, {
      responseType: 'blob'
    })
    data = res.data
  } else {
    data = file
  }

  const reader = new FileReader()
  const isGzip = data.type === 'application/gzip'

  if (isGzip) {
    reader.readAsArrayBuffer(data)
  } else {
    reader.readAsText(data)
  }

  const numSnps = Object.keys(snps.rs).length
  let samples
  const genotypes = {}

  reader.onload = event => {
    let content = event.target.result
    if (isGzip) {
      content = pako.ungzip(content, { to: 'string' })
    }
    let line = ''
    let snpCount = 0
    //console.log('[start] read input file')

    for (let char of content) {
      if (char === '\n') {
        if (line.startsWith('#')) {
          line = ''
          continue
        }
        const fields = line.split('\t')
        if (!samples) {
          samples = fields.slice(1)
          for (const sample of samples) {
            genotypes[sample] = new Uint8Array(numSnps)
          }
        } else {
          const snpId = fields[0]
          let rsId
          let isAffy = false
          if (snpId in snps.affy) {
            rsId = snps.affy[snpId].rsId
            isAffy = true
          } else {
            rsId = snpId
          }
          if (!(rsId in snps.rs)) {
            line = ''
            continue
          }
          snpCount += 1
          const index = snps.rs[rsId]
          for (const [sample, genotype] of _.zip(samples, fields.slice(1))) {
            let gt = Number.parseInt(genotype, 10)
            if (isAffy && snps.affy[snpId].allele === 'AlleleB') {
              if (gt === 0) {
                gt = 2
              } else if (gt === 2) {
                gt = 0
              }
            }
            // TODO figure out how to deal with those properly
            if (gt < 0 || gt > 2) {
              gt = 0
            }
            genotypes[sample][index] = gt
          }
        }
        line = ''
      } else {
        line += char
      }
    }
    //console.log(`[  end] read input file (n model snps=${snpCount})`)

    // TODO check that samples have at least 1% non-ref genotypes

    const results = []
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const sample = samples[sampleIndex]
      //console.log(`[start] processing sample ${sample}`)
      const data = genotypes[sample]
      //console.log('raw genotypes', _.countBy(data))
      const gts = hilbertCurve.construct(data, order)
      //console.log('binned genotypes', _.countBy(gts))

      const grayscaleValues = gts.map(gt => {
        if (gt === 2) {
          return 0
        }
        if (gt === 1) {
          return 0.5
        }
        return 1
      })

      //console.log('grayscale values', _.countBy(grayscaleValues))

      const pred = tf.tidy(() => {
        const grayscaleValueTensor = tf.tensor1d(grayscaleValues)
        const xs = tf.reshape(grayscaleValueTensor, [-1, 128, 128, 1])
        return model.predict(xs)
      })

      const probs = pred.dataSync()
      const vlSpec = {
        title: 'Probability of ancestry',
        data: { values: [] },
        mark: 'bar',
        encoding: {
          y: { field: 'population', type: 'nominal', axis: { title: null } },
          x: {
            field: 'probability',
            type: 'quantitative',
            axis: { title: null }
          }
        },
        $schema: 'https://vega.github.io/schema/vega-lite/v4.0.0-beta.9.json'
      }
      probs.forEach((prob, i) => {
        vlSpec.data.values.push({
          population: modelClassNames[i].label,
          probability: prob
        })
      })

      postMessage({
        type: 'result',
        value: {
          sample,
          prediction: probs,
          vlSpec,
          hilbert: grayscaleValues
        }
      })

      //console.log(`[  end] processing sample ${sample}`)
    }
    postMessage({ type: 'EOM', value: null })
  }
})
