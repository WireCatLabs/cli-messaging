import * as ort from "onnxruntime-web"
import { readFileSync } from "node:fs"
const f = process.argv[2]
const s = await ort.InferenceSession.create(readFileSync(f), { externalData: [{ path: f.split("/").pop() + "_data", data: readFileSync(f + "_data") }] })
console.log(f, "in:", s.inputNames, "out:", s.outputNames)
