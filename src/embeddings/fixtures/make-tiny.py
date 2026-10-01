# Writes tiny/: a 5-word tokenizer and a model that looks each token up in a 4-number table, with the
# inputs and the output of a real embedding model. Run: uv run --with onnx python make-tiny.py
import json, os
import onnx
from onnx import TensorProto, helper

os.makedirs("tiny/onnx", exist_ok=True)
table = [[0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [1, 1, 0, 0], [0, 0, 0, 0]]
graph = helper.make_graph(
    [helper.make_node("Gather", ["table", "input_ids"], ["last_hidden_state"])],
    "tiny",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "n"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "n"]),
    ],
    [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, "n", 4])],
    [helper.make_tensor("table", TensorProto.FLOAT, [6, 4], [x for row in table for x in row])],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
onnx.checker.check_model(model)
onnx.save(model, "tiny/onnx/model.onnx")

vocab = {"[UNK]": 0, "cat": 1, "dog": 2, "fish": 3, "query:": 4, "[SEP]": 5}
tokenizer = {
    "version": "1.0",
    "truncation": None,
    "padding": None,
    "added_tokens": [],
    "normalizer": None,
    "pre_tokenizer": {"type": "Whitespace"},
    "post_processor": None,
    "decoder": None,
    "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "[UNK]"},
}
json.dump(tokenizer, open("tiny/tokenizer.json", "w"))
json.dump({}, open("tiny/tokenizer_config.json", "w"))
