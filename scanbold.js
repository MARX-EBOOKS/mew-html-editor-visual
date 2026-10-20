async function scanBold(page, items, fonts) {
    const ops = window.pdfjsLib?.OPS || { save: 10, restore: 11, transform: 12, paintImageXObject: 85 };
    const list = await page.getOperatorList(), images = [], stack = [];
    let matrix = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i], args = list.argsArray[i];
        if (fn === ops.save) stack.push(matrix.slice());
        else if (fn === ops.restore && stack.length) matrix = stack.pop();
        else if (fn === ops.transform) {
            const [a, b, c, d, e, f] = matrix, [g, h, j, k, l, m] = args;
            matrix = [a * g + c * h, b * g + d * h, a * j + c * k, b * j + d * k, a * l + c * m + e, b * l + d * m + f];
        } else if (fn === ops.paintImageXObject) images.push({ id: args[0], matrix: matrix.slice() });
    }
    if (images.length !== 1 || !page.objs) return;
    const { id, matrix: [a, b, c, d, e, f] } = images[0];
    if (a <= 0 || d <= 0 || Math.abs(b) > 0.001 || Math.abs(c) > 0.001) return;
    const image = await new Promise(resolve => page.objs.get(id, resolve));
    if (!image?.width || !image.height) return;
    let { data, width, height, kind } = image;
    if (image.bitmap) {
        const canvas = window.document?.createElement('canvas');
        if (!canvas) return;
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image.bitmap, 0, 0);
        data = ctx.getImageData(0, 0, width, height).data; kind = 3;
        canvas.width = canvas.height = 0;
    }
    if (!data || ![1, 2, 3].includes(kind)) return;
    const black = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        if (kind === 1) return !(data[y * Math.ceil(width / 8) + (x >> 3)] & (128 >> (x & 7)));
        const offset = (y * width + x) * (kind === 2 ? 3 : 4);
        return (kind === 2 || data[offset + 3] >= 128) &&
            (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) < 160;
    };
    const samples = [];
    for (const item of items) {
        const t = item.transform, count = (item.str?.match(/\p{L}/gu) || []).length;
        if (count < 4 || !t || Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01 || t[0] <= 0 || t[3] <= 0) continue;
        const size = Math.abs(t[3]), h = size * height / d;
        const x0 = Math.floor((t[4] - e) * width / a), x1 = Math.ceil((t[4] + item.width - e) * width / a);
        const y0 = Math.floor((1 - (t[5] + size * 0.9 - f) / d) * height),
            y1 = Math.ceil((1 - (t[5] - size * 0.2 - f) / d) * height);
        if (h < 12 || x0 < 1 || y0 < 1 || x1 >= width - 1 || y1 >= height - 1 || x1 <= x0 || y1 <= y0) continue;
        let ink = 0, edges = 0, top = y1, bottom = y0;
        for (let y = y0; y < y1; y++) {
            let row = 0;
            for (let x = x0; x < x1; x++) if (black(x, y)) {
                ink++; row++;
                edges += Number(!black(x - 1, y)) + Number(!black(x + 1, y))
                    + Number(!black(x, y - 1)) + Number(!black(x, y + 1));
            }
            if (row >= Math.max(3, count * 0.4)) { top = Math.min(top, y); bottom = y; }
        }
        const coverage = ink / ((x1 - x0) * (y1 - y0));
        const inkHeight = bottom - top + 1;
        if (edges && inkHeight >= h * 0.4 && coverage > 0.03 && coverage < 0.5)
            samples.push({ item, size: inkHeight, em: h, count, score: 2 * ink / edges / inkHeight });
    }
    // A substantial same-size body-text population is required. A uniformly
    // heavy page cannot establish regular text and must remain unknown.
    for (const sample of samples) {
        // OCR can assign a larger nominal size to bold words; actual ink height
        // also varies with ascenders/descenders. Allow both within a body-size band.
        const peers = samples.filter(peer => Math.abs(peer.em / sample.em - 1) < 0.25
            && Math.abs(peer.size / sample.size - 1) < 0.4
            && fonts.get(peer.item.fontName)?.italic === fonts.get(sample.item.fontName)?.italic);
        if (peers.length < 8 || peers.reduce((sum, peer) => sum + peer.count, 0) < 120) continue;
        const scores = peers.map(peer => peer.score).sort((x, y) => x - y);
        const baseline = scores[Math.floor(scores.length * 0.4)];
        const low = scores[Math.floor(scores.length * 0.15)];
        if (baseline / low > 1.2) continue;
        const ratio = sample.score / baseline;
        // Only positive evidence is used: never infer missing bold from a scan.
        if (ratio < 1.4 || ratio > 2.4 || peers.filter(peer => peer.score > baseline * 1.3).length > peers.length * 0.25) continue;
        fonts.set(JSON.stringify([sample.item.fontName, sample.item.str, sample.item.transform, sample.item.width]), {
            ...fonts.get(sample.item.fontName), bold: true,
            reason: '扫描笔画相对同页同字号正文显著加粗（估计）', scanBoldRatio: ratio
        });
    }
}