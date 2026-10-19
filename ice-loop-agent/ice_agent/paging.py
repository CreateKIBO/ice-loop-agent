"""Shared bounds for local metadata pages; never interpolate SQL identifiers."""
def page_request(params, columns):
    size, page = params.get('page_size'), params.get('page', 0)
    if type(size) is not int or not 1 <= size <= 100 or type(page) is not int or not 0 <= page <= 100000:
        raise ValueError('分页大小需为1–100，页码需为0–100000内的整数')
    series, query = params.get('series', ''), params.get('query', '')
    if not isinstance(series, str) or series and series not in columns:
        raise ValueError('请选择当前公众号的栏目')
    if not isinstance(query, str) or len(query) > 200 or '\x00' in query:
        raise ValueError('搜索词需为不超过200字的文本')
    return size, page, series, query.strip()


def page_bounds(total, page, size):
    pages = max(1, (total + size - 1) // size)
    return min(page, pages - 1), pages
