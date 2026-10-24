from pathlib import Path
import re

p = Path('tests/test_reader_backend.py')
s = p.read_text('utf-8').replace('import gzip\n', '')
s = s.replace('test_page_results_regenerate_if_missing_and_compress_without_size_limit', 'test_plain_json_pages_regenerate_if_missing_and_preserve_large_results')
s = s.replace("self.assertEqual(page.suffix, '.gz')", "self.assertEqual(page.suffix, '.json')")
s = s.replace("self.assertGreater(len(gzip.decompress(page.read_bytes())), 5_000_000)\n        self.assertLess(page.stat().st_size, 5_000_000)", "self.assertGreater(page.stat().st_size, 5_000_000)\n        self.assertIsInstance(json.loads(page.read_text('utf-8')), dict)")
p.write_text(s, 'utf-8')
p = Path('tests/pdf-review-popup-browser.mjs')
s = p.read_text('utf-8').replace('servers.forEach(server => server.kill());', 'await Promise.all(servers.map(stopServer));')
p.write_text(s, 'utf-8')

# Drop imports and setup constants no longer used after separating browser tests.
for p in Path('tests').glob('pdf-selection-*.mjs'):
 s = p.read_text('utf-8')
 for match in list(re.finditer(r"^import \{ ([^\n]+) \} from ('[^']+');$", s, re.M)):
  names = match[1].split(', ')
  used = [name for name in names if len(re.findall(r'\b' + re.escape(name.split(' as ')[-1]) + r'\b', s)) > 1]
  replacement = f"import {{ {', '.join(used)} }} from {match[2]};" if used else ''
  s = s.replace(match[0], replacement)
 p.write_text(s, 'utf-8')
