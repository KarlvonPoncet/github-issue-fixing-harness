def summarize_log(lines):
    counts = {}
    for line in lines:
        level = line.split(" ", 1)[0]
        counts[level] = counts.get(level, 0) + 1
    return counts
