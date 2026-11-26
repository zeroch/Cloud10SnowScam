"""Package the captured, rendered UI and original assets for the local prototype.

Authoring-only dependencies: BeautifulSoup and Pillow. No production OpenSnow
JavaScript, credentials, hydration data, or remote assets are included.
"""
import hashlib
import json
import re
import shutil
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Comment
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CAP = ROOT / 'docs/research/2026-10-14-clone'
OUT = ROOT / 'public/clone'
OUT.mkdir(exist_ok=True)
(OUT / 'assets').mkdir(exist_ok=True)
(OUT / 'charts').mkdir(exist_ok=True)
assets = {}
asset_records = {}
missing = set()
for manifest in sorted(CAP.glob('*bundle.json')):
    for asset in json.loads(manifest.read_text())['assets']:
        source = Path(asset['path'])
        if not source.is_absolute():
            source = CAP / source
        if not source.exists():
            continue
        name = asset['id'] + source.suffix
        target = OUT / 'assets' / name
        shutil.copyfile(source, target)
        assets[asset['url']] = '/clone/assets/' + name
        asset_records[asset['url']] = {**asset, 'path': str(source), 'local': '/clone/assets/' + name}

shutil.copyfile(CAP / 'source-assets/snow-stake-full.webp', OUT / 'assets/snow-stake-full.webp')
for stale_plot in (OUT / 'charts').glob('*.png'):
    if re.fullmatch(r'(favorites|stevens)-[0-9]+\.png', stale_plot.name):
        stale_plot.unlink()

def resource(url, base='https://opensnow.com/'):
    if not url or url.startswith(('data:', '#')):
        return url
    absolute = urljoin(base, url)
    if absolute in assets:
        return assets[absolute]
    normalized = absolute.split('?')[0]
    for known, local in assets.items():
        if known.split('?')[0] == normalized:
            return local
    missing.add(absolute)
    return ''

def css_urls(text, base='https://opensnow.com/'):
    def replace(match):
        url = match.group(1).strip().strip('\"\'')
        return 'url("' + resource(url, base) + '")'
    return re.sub(r'url\(([^)]+)\)', replace, text)

for url, asset in asset_records.items():
    if asset['kind'] == 'stylesheet':
        path = OUT / asset['local'].removeprefix('/clone/')
        path.write_text(css_urls(Path(asset['path']).read_text(), url))

FAV = '/user/favorites/locations/snow-summary'
DETAIL = '/location/stevenspass/snow-summary'

def clean(html):
    soup = BeautifulSoup(html, 'html.parser')
    for node in soup.find_all(string=lambda s: isinstance(s, Comment)):
        node.extract()
    for node in soup.select('script,iframe,link[rel="preload"],#mainMapHost,#mapContainer'):
        node.decompose()
    for node in soup.find_all(True):
        for attr in list(node.attrs):
            if attr.lower().startswith('on'):
                del node[attr]
        if node.has_attr('src'):
            node['src'] = resource(node['src'])
        if node.has_attr('srcset'):
            del node['srcset']
        if node.has_attr('style'):
            node['style'] = css_urls(node['style'])
        if node.name == 'a' and node.has_attr('href'):
            href = node['href']
            if href in ['/', '/user/favorites', '/user/favorites/locations', FAV]:
                node['href'] = FAV
            elif href == DETAIL:
                pass
            elif href.startswith('javascript:'):
                node['href'] = '#'
                node['data-local-action'] = 'true'
            elif href.startswith('#'):
                pass
            elif 'logout' in href:
                node['href'] = '#'
                node['data-local-logout'] = 'true'
            else:
                node['href'] = urljoin('https://opensnow.com', href)
                node['target'] = '_blank'
                node['rel'] = 'noopener noreferrer'
        if node.name == 'button' and not node.get('type'):
            node['type'] = 'button'
    return soup

def capture(name):
    return json.loads((CAP / (name + '.json')).read_text())

def crop(rect, image, name):
    box = (round(rect['x']), round(rect['y']), round(rect['x'] + rect['width']), round(rect['y'] + rect['height']))
    image.crop(box).save(OUT / 'charts' / (name + '.png'))
    return '/clone/charts/' + name + '.png'

def mark_sections(soup):
    for heading in soup.select('h2'):
        text = heading.get_text(' ', strip=True)
        if text in ['Hourly Forecast', 'Daily Forecast', 'Forecast Range', 'Precipitation by Model']:
            heading.find_parent('section')['data-section'] = text.lower().replace(' ', '-')
    for node in soup.select('.SnowSummary__container'):
        node.find_parent('section')['data-snow-card'] = 'true'
    return soup

def page(name):
    source = capture(name + '-desktop')
    soup = mark_sections(clean(source['html']))
    rects = capture(name + '-desktop-rects')
    image = Image.open(CAP / (name + '-desktop-full.jpg'))
    snowfall = json.loads((CAP / 'snowfall-bars.json').read_text())
    displayed_totals = {item['index']: item['total'] for item in capture('correct-favorites-0')['canvases']}
    for index, canvas in enumerate(soup.select('canvas')):
        if canvas.find_parent(class_='ForecastRangeChart__chartContainer'):
            continue
        rect = rects['canvases'][index]
        item = canvas.find_parent('li', class_='list-item-chart')
        total = item.select_one('h3').get_text(strip=True) if item else None
        if name == 'favorites' and item:
            total = displayed_totals[index]
            total_label = item.select_one('h3 span') or item.select_one('h3')
            total_label.string = total
        values = snowfall['bars'].get(str(index), [0] * 5) if name == 'favorites' else [0] * 5
        blue = snowfall['blue'].get(str(index), []) if name == 'favorites' else []
        if total != '0"' and not any(values):
            raise ValueError(f'Missing captured chart values: {name} {index}')
        replacement = soup.new_tag('div', attrs={'class': 'clone-snow-bars', 'role': 'img', 'aria-label': 'Captured daily snowfall: ' + ', '.join(map(str, values)) + ' inches'})
        for day, value in enumerate(values):
            column = soup.new_tag('div', attrs={'class': 'clone-snow-day' + (' clone-historical-bar' if index % 5 < 3 else ''), 'style': '--snow-height:' + str(value * 4.5) + 'px;--snow-color:' + ('#2c7fbd' if day in blue else '#9585c2')})
            number = soup.new_tag('span', attrs={'class': 'clone-snow-number' + (' clone-snow-zero' if value == 0 else '')}); number.string = str(value)
            bar = soup.new_tag('i', attrs={'aria-hidden': 'true'})
            column.extend([number, bar]); replacement.append(column)
        canvas.replace_with(replacement)
    if name == 'stevens':
        for mode in ['desktop', 'mobile']:
            data = capture('stevens-' + mode + '-rects')
            full = Image.open(CAP / ('stevens-' + mode + '-full.jpg'))
            direct = CAP / ('range-' + mode + '-direct.jpg')
            if direct.exists():
                Image.open(direct).save(OUT / 'charts' / ('range-' + mode + '.png'))
            else:
                crop(data['range'][0], full, 'range-' + mode)
        chart = soup.select_one('.ForecastRangeChart__chartContainer')
        overlay = chart.select_one('.UpgradeOverlay__overlay').extract()
        overlay['class'].append('clone-captured-overlay-links')
        chart.clear()
        chart['class'].append('clone-range-preview')
        picture = BeautifulSoup('<picture><source media="(max-width: 991px)" srcset="/clone/charts/range-mobile.png"><img src="/clone/charts/range-desktop.png" alt="Captured OpenSnow Premium model chart preview"></picture>', 'html.parser')
        chart.append(picture)
        chart.append(overlay)
    return source, soup

fav_source, fav = page('favorites')
detail_source, detail = page('stevens')

# Keep every default card independently addressable for local sorting/editing.
locations = []
for index, card in enumerate(fav.select('[data-snow-card]')):
    link = card.select_one('header h2 a')
    if not link:
        continue
    slug = urlsplit(link['href']).path.split('/')[2]
    card['data-location'] = slug
    card.find_parent('li')['data-location-row'] = slug
    titles = [h.get_text(' ', strip=True) for h in card.select('h3')]
    totals = [float(re.sub(r'[^0-9.]', '', t) or '0') for t in titles if re.fullmatch(r'[0-9.]+\"', t)]
    last_day = re.search(r'([0-9.]+)\"', card.select_one('.SnowSummary__container > li:nth-child(2)').get_text())
    totals.insert(3, float(last_day.group(1)) if last_day else 0)
    locations.append({'id': slug, 'name': link.get_text(strip=True), 'href': link['href'], 'order': index,
                      'type': 'Heli Ski Operation' if slug.startswith('cmh') else 'Cat Ski Operation' if 'cat' in slug else 'Ski Resort',
                      'totals': totals,
                      'open': 'Opening' not in card.get_text() and 'Closed' not in card.get_text()})

edit = clean(capture('favorites-edit-desktop')['html']).select_one('#pageContent')
for row in edit.select('li'):
    link_text = row.get_text(' ', strip=True)
    item = next((item for item in locations if link_text.startswith(item['name'] + ' ')), None)
    if item:
        row['data-edit-location'] = item['id']

def section_from(name, section):
    soup = mark_sections(clean(capture(name)['html']))
    return str(soup.select_one('[data-section="' + section + '"]'))

nav_open = clean(capture('favorites-menu-mobile')['html']).select_one('nav')
list_modal = clean(json.loads((CAP / 'lists-modal-mobile.json').read_text())['html'])
add_modal = clean((CAP / 'add-modal.html').read_text()).select_one('dialog')
add_modal.attrs.pop('open', None)
filter_source = clean(capture('favorites-filter-desktop')['html'])
filter_content = filter_source.select_one('.CompareOptions__contentContainer')
rename_source = clean(capture('favorites-rename-desktop')['html'])
rename_input = rename_source.select_one('#listNameEditor input')
rename_form = rename_input.find_parent(id='listNameEditor')
selection_source = clean((CAP / 'favorites-selection.html').read_text())
selected_row = selection_source.select_one('li[data-index="0"]')

states = {
    'locations': locations,
    'edit': str(edit),
    'navOpen': str(nav_open),
    'lists': str(list_modal),
    'add': str(add_modal),
    'filter': str(filter_content),
    'rename': str(rename_form),
    'selectionToolbar': str(selection_source.select_one('.BulkEditToolbar__stickyTop')),
    'selectedCheck': str(selected_row.select_one('.js-bulk-edit-checkbox svg')),
    'selectedRemove': str(selected_row.select_one('.js-bulk-edit-delete')),
    'forecastMenuMobile': str(clean((CAP / 'forecast-menu-mobile.html').read_text())),
    'forecastMenuDesktop': str(clean((CAP / 'forecast-menu-desktop.html').read_text())),
    'precipMenuMobile': str(clean((CAP / 'precip-menu-mobile.html').read_text())),
    'precipMenuDesktop': str(clean((CAP / 'precip-menu-desktop.html').read_text())),
    'accountMenu': str(clean((CAP / 'account-menu.html').read_text())),
    'hourlyHistory': section_from('stevens-hourly-history-desktop', 'hourly-forecast'),
    'dailyHistory': section_from('stevens-daily-history-desktop', 'daily-forecast'),
    'modelOptions': ['🌎 All Models (last 3 runs)', '🇺🇸 American (GFS)', '🇺🇸 American Hi-Res (HRRR)', '🇨🇦 Canadian (GDPS)', '🇨🇦 Canadian Hi-Res (HRDPS)', '🇨🇦 Canadian Regional (RDPS)', '🇪🇺 European (ECMWF)', '🇪🇺 European AI (AIFS)', '🇩🇪 German (ICON)', '🇺🇸 American Ens (AIGEFS)', '🇪🇺 AIFS Ens (AIFS-E)'],
}
(OUT / 'states.json').write_text(json.dumps(states, ensure_ascii=False, separators=(',', ':')))

styles = []
for source in [fav_source, detail_source, capture('favorites-add-desktop'), capture('favorites-menu-mobile')]:
    for url in source['styles']:
        local = resource(url)
        if local and local not in styles:
            styles.append(local)

inline = list(dict.fromkeys(fav_source['inlineStyles'] + detail_source['inlineStyles']))
(OUT / 'captured-inline.css').write_text('\n'.join(css_urls(style) for style in inline))
for name, soup in [('favorites', fav), ('stevens', detail)]:
    title = 'Favorites' if name == 'favorites' else 'Stevens Pass'
    head = ''.join('<link rel="stylesheet" href="' + src + '">' for src in styles)
    html = '<!doctype html><html lang="en" data-theme="light" style="--app-safe-area-top:0px;--app-safe-area-bottom:0px;--app-tab-bar-offset:0px;--app-scroll-offset-top:84px"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Local OpenSnow UI reference prototype. Forecast values are captured examples, not current conditions."><title>' + title + ' — OpenSnow local preview</title>' + head + '<link rel="stylesheet" href="/clone/captured-inline.css"><link rel="stylesheet" href="/clone/clone.css"></head><body id="body" data-page="' + name + '">' + str(soup) + '<script type="module" src="/clone/controller.mjs"></script></body></html>'
    (OUT / (name + '.html')).write_text(html)
(OUT / 'asset-manifest.json').write_text(json.dumps({url: {'local': a['local'], 'kind': a['kind']} for url, a in asset_records.items()}, indent=2))
print(json.dumps({'assets': len(assets), 'stylesheets': len(styles), 'locations': len(locations), 'missing': sorted(missing)}, indent=2))
import runpy
runpy.run_path(str(ROOT / 'scripts/enable-live.py'), run_name='__main__')
