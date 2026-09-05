"""Opaque content revisions shared with the formal Rust save contract."""
import hashlib
import json


class StorageConflict(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def content_revision(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def metadata_revision(directory):
    book = directory / "book.json"
    if not book.is_file():
        return "missing"
    value = json.loads(book.read_text(encoding="utf-8"))
    value = {k: v for k, v in value.items()
             if not k.startswith("_") and k not in ("chapters", "updatedAt")}
    encode = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return content_revision(encode(value))


def check_revision(expected, actual, required=False, kind="BOOK"):
    if expected is None and required:
        raise StorageConflict("REVISION_REQUIRED", "缺少保存基线，请重新读取后保存")
    if expected is not None and expected != actual:
        raise StorageConflict(f"{kind}_CONFLICT", "磁盘版本已变化，当前草稿已保留，请比较版本后重试")
