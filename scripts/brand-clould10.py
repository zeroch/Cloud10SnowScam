"""Apply Clould10's identity to the two-page app after shell generation.

Historical research stays in docs/research; only active public assets are kept.
"""
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/clone'
FAVORITES = '/user/favorites/locations/snow-summary'
STEVENS = '/location/stevenspass/snow-summary'


def fragment(html):
    return BeautifulSoup(html, 'html.parser').find()


def wordmark():
    return ('<span class="club-emblem"><img src="/clone/brand/cloud10-logo.jpg" width="1024" height="1024" alt=""></span>'
            '<span class="club-lettering">Cloud10<small>Ski Club</small></span>')


def navigation(page):
    return fragment(f'''<nav class="clould-nav Main__siteHeader" aria-label="Main navigation">
      <a class="clould-wordmark club-signature" href="{FAVORITES}" aria-label="Cloud10 home">{wordmark()}</a>
      <button class="clould-menu" aria-label="Main menu" aria-controls="clould-nav-links" aria-expanded="false"><span></span><span></span></button>
      <div class="clould-nav-links" id="clould-nav-links">
        <a href="{FAVORITES}" {'aria-current="page"' if page == 'favorites' else ''}>Compare resorts</a>
        <a href="{STEVENS}" {'aria-current="page"' if page == 'stevens' else ''}>Stevens Pass</a>
        <a href="{STEVENS}#live-models">Models</a>
        <div class="clould-search tw-relative"><input type="search" aria-label="Search resorts" placeholder="Search resorts" autocomplete="off"></div>
      </div>
    </nav>''')


def page_header(page, editing=False):
    if page == 'favorites':
        title = '<div id="listNameEditor"><h1 class="SelectFavoriteListDropdown__selectFavoriteListActiveListName">Winter</h1></div>'
        subtitle = 'Your mountains. Saved on this device.'
        actions = '<button class="clould-button">Rename List</button><button class="clould-button clould-button-primary">Done</button>' if editing else '<button class="clould-button">Edit</button>'
        tabs = [(FAVORITES, 'Snow Summary'), (STEVENS + '#live-models', 'Compare Models')]
        eyebrow = 'YOUR FAVORITES'
    else:
        title = '<h1>Stevens Pass</h1>'
        subtitle = 'Washington Cascades <span aria-hidden="true">·</span> Brooks forecast at 4,800 ft'
        actions = f'<a class="clould-button" href="{FAVORITES}">Favorites</a>'
        tabs = [(STEVENS + '#live-summary', 'Snow Summary'), ('#live-overnight', 'Overnight'), ('#live-observations', 'Observations'), ('#live-daily', 'Daily'), ('#live-models', 'Forecast Range'), ('#live-precip', 'Precipitation')]
        eyebrow = 'YOUR MOUNTAIN'
    links = ''.join(f'<a href="{url}">{label}</a>' for url, label in tabs)
    return fragment(f'''<header id="pageHeader" class="clould-page-header">
      <div class="clould-heading-row"><div><p class="clould-eyebrow">{eyebrow}</p>{title}<p class="clould-subtitle">{subtitle}</p></div>
      <div class="clould-page-actions">{actions}</div></div>
      <div id="pageHeaderBottomRowNavigation" class="clould-section-nav" aria-label="Page sections">{links}</div>
    </header>''')


def clean_content(soup, page, source_labels, editing=False):
    for avatar in soup.select('.AccountMenu__triggerAvatar[aria-label], .AvatarList__stacked[aria-label]'):
        label = avatar['aria-label'].strip()
        if label:
            source_labels.add(label)
    source_identity = re.compile('|'.join(re.escape(label) for label in sorted(source_labels, key=len, reverse=True)), re.I)
    # Captured exit transitions never finish without their original framework.
    # This transparent cover intercepted pointer input over the Favorites card.
    for cover in list(soup.select('.PageBodyLoading__bodyContainer')):
        cover.decompose()
    header = soup.select_one('#pageHeader')
    if header:
        header.replace_with(page_header(page, editing))
    for strip in list(soup.select('.SnowSummaryCamStrip__strip')):
        strip.replace_with(fragment('''<aside class="clould-camera-card"><div><p class="clould-eyebrow">A LOOK AT THE MOUNTAIN</p><h2>Stevens Pass cameras</h2><p>Snow stake, base area and upper-mountain views.</p></div><a href="https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx" target="_blank" rel="noreferrer">Open resort cameras <span aria-hidden="true">↗</span></a></aside>'''))
    for node in list(soup.select('a[href]')):
        if re.search(r'opensnow\.com|opensummit\.com', node['href'], re.I):
            node.unwrap()
    for node in soup.select('img:not(.club-emblem > img)'):
        # Resort and account images came from the captured page. Use our own mark.
        node['src'] = '/favicon.svg'
        node['alt'] = ''
        for attribute in ['srcset', 'data-src', 'data-srcset']:
            node.attrs.pop(attribute, None)
    for node in soup.find_all(True):
        for key in list(node.attrs):
            value = str(node.attrs[key])
            if source_identity.search(value):
                del node.attrs[key]
    # Strip obsolete captured edit rows and actions, including hidden dropdowns.
    for row in list(soup.select('li:has(.js-bulk-edit-row-name)')):
        if row.get('data-edit-location') != 'stevenspass':
            row.decompose()
    for button in list(soup.select('button')):
        if button.get_text(' ', strip=True) in ['Move to Another List', 'Copy to Another List', 'Summer', 'Add New List', 'Delete List']:
            button.decompose()
    for link in soup.select('a'):
        if link.get_text(strip=True) == 'Back to List View':
            link['href'] = FAVORITES
    for text in list(soup.find_all(string=True)):
        if text.parent.name in ('style', 'script'):
            continue
        value = str(text).replace('1 Locations', '1 Location')
        value = source_identity.sub('Clould10', value)
        if value != str(text):
            text.replace_with(value)
    for name, anchor in [('summary', 'live-summary'), ('outlook', 'live-overnight'), ('stations', 'live-observations'), ('daily-forecast', 'live-daily'), ('precipitation-by-model', 'live-precip')]:
        slot = soup.select_one(f'[data-live-slot="{name}"]')
        if slot:
            section = slot.find_parent('section')
            (section if section is not None else slot)['id'] = anchor


def apply_brand():
    source_labels = {'OpenSnow', 'OpenSummit'}
    for page in ['favorites', 'stevens']:
        path = OUT / f'{page}.html'
        soup = BeautifulSoup(path.read_text(), 'html.parser')
        soup.title.string = f'{"Favorites" if page == "favorites" else "Stevens Pass"} · Clould10'
        for link in list(soup.head.select('link[rel="icon"], link[href="/clone/clould10.css"]')):
            link.decompose()
        soup.head.append(soup.new_tag('link', rel='icon', href='/favicon.svg', type='image/svg+xml'))
        soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/clould10.css'))
        theme = soup.head.select_one('meta[name="theme-color"]') or soup.new_tag('meta', attrs={'name': 'theme-color'})
        theme['content'] = '#fafbfc'
        if not theme.parent:
            soup.head.append(theme)
        clean_content(soup, page, source_labels)
        soup.select_one('nav').replace_with(navigation(page))
        footer = soup.select_one('footer.Main__siteFooter')
        footer.replace_with(fragment(f'''<footer class="clould-footer Main__siteFooter"><div><a class="clould-wordmark club-signature" href="{FAVORITES}" aria-label="Cloud10 home">{wordmark()}</a></div><div class="clould-footer-sources"><span>Independent forecasts. Local observations.</span><div><a href="https://nwac.us/" target="_blank" rel="noreferrer">NWAC</a><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a><a href="https://www.weather.gov/" target="_blank" rel="noreferrer">NOAA / NWS</a></div><small>Model data: CC BY 4.0 · Normalized and aggregated by Cloud10.</small></div></footer>'''))
        # Empty captured overlays otherwise leave unnecessary grid rows.
        for node in list(soup.select('#root > span')):
            node.decompose()
        path.write_text(str(soup))

    path = OUT / 'states.json'
    all_states = json.loads(path.read_text())
    keep = ['locations', 'edit', 'lists', 'add', 'filter', 'rename', 'selectionToolbar', 'selectedCheck', 'selectedRemove']
    states = {key: all_states[key] for key in keep}
    for key, value in states.items():
        if not isinstance(value, str):
            continue
        soup = BeautifulSoup(value, 'html.parser')
        clean_content(soup, 'favorites', source_labels, editing=key == 'edit')
        states[key] = str(soup)
    path.write_text(json.dumps(states, ensure_ascii=False, separators=(',', ':')))

    # The old snow chart watermark and unused brand selectors are not shipped.
    for path in OUT.rglob('*.css'):
        text = path.read_text()
        text = re.sub(r'--watermark-image\s*:\s*url\([^)]*\)', '--watermark-image:none', text)
        text = re.sub(r'\.PeaksIcon__peaksIcon\{[^}]*\}', '', text)
        text = text.replace('opensnow-blue', 'clould-blue')
        path.write_text(text)

    # Resolve local asset references transitively, retaining fonts and UI styles.
    referenced = {OUT / 'assets/Clear-Sans-LICENSE.txt'}
    queue = [path for path in OUT.iterdir() if path.is_file() and path.suffix in ('.html', '.css', '.mjs')]
    queue.append(OUT / 'states.json')
    while queue:
        text = queue.pop().read_text()
        for local in re.findall(r'/clone/(?:assets|charts)/[^\s"\'<>\\)]+', text):
            path = ROOT / 'public' / local.lstrip('/')
            if path not in referenced and path.exists():
                referenced.add(path)
                if path.suffix == '.css':
                    queue.append(path)
    for directory in ['assets', 'charts']:
        for path in (OUT / directory).glob('*'):
            if path.is_file() and path not in referenced:
                path.unlink()
    (OUT / 'asset-manifest.json').unlink(missing_ok=True)


if __name__ == '__main__':
    apply_brand()
    import runpy
    runpy.run_path(str(ROOT / 'scripts/apply-overnight-layout.py'), run_name='__main__')
