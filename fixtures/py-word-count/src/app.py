def word_counts(text):
    words = text.split()
    return {word: words.count(word) for word in words}
