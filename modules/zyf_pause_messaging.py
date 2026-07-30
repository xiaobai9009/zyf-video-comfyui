from server import PromptServer


def send_progress(uid, graph_id, message: str, current: int | None = None, total: int | None = None):
    """Push a small progress / status message to the front-end so the
    node's preview area can show "Reading media info..." / "Extracting
    frames..." while the pipeline is running.

    The old pause / wait-for-response flow has been removed (the
    "执行时暂停" widget was deleted for a more compact UI), so the rest
    of this module's surface area is gone too — only this helper is
    still needed.
    """
    PromptServer.instance.send_sync(
        "zyf-frame-selector-progress",
        {"uid": uid, "graph_id": graph_id, "message": message, "current": current, "total": total},
    )
