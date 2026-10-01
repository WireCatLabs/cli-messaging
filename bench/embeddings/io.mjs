import * as ort from "onnxruntime-web"
for (const f of process.argv.slice(2)) {
  const s = await ort.InferenceSession.create(f)
  console.log(f, "in:", s.inputNames, "out:", s.outputNames)
}
