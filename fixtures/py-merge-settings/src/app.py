def merge_settings(defaults, overrides):
    result = dict(defaults)
    result.update(overrides)
    return result
