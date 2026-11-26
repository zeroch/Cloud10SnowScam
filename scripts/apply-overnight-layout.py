"""Apply the approved phone-first overnight hierarchy to the existing two routes.

Idempotent, also invoked after legacy shell regeneration. No forecast data changes.
"""
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]

def apply_layout():
    for page in ['favorites', 'stevens']:
        path = ROOT / 'public/clone' / f'{page}.html'
        soup = BeautifulSoup(path.read_text(), 'html.parser')
        content = soup.select_one('#pageContent')
        # Detach the working evidence sections before simplifying their wrappers.
        evidence = []
        if page == 'stevens':
            for key in ['live-daily', 'live-models', 'live-precip']:
                section = soup.select_one('#' + key)
                if section: evidence.append(section.extract())
        camera = soup.select_one('.clould-camera-card')
        if camera: camera.extract()
        content.clear()
        content['class'] = ['container', 'page-content', 'cloud-page']
        content.attrs.pop('style', None)
        intro = BeautifulSoup('''<section id="live-summary" aria-label="Stevens Pass overnight forecast">
          <div class="live-slot" data-live-slot="summary"><p class="cloud-loading" role="status">Loading the overnight forecast…</p></div>
        </section>''', 'html.parser')
        for node in list(intro.contents): content.append(node)
        if page == 'stevens':
            nav = BeautifulSoup('''<nav class="cloud-evidence-nav" aria-label="Forecast sections">
              <a href="#live-overnight">Overnight</a><a href="#live-daily">Daily forecast</a>
              <a href="#live-models">Forecast range</a><a href="#live-precip">Precipitation</a>
            </nav>''', 'html.parser')
            for node in list(nav.contents): content.append(node)
            comparison = BeautifulSoup('''<section id="live-comparison" aria-label="Shared forecast comparison settings"><div class="live-slot" data-live-slot="comparison-controls">Loading comparison controls…</div></section><p class="cloud-comparison-context">These settings apply to Daily Forecast, Forecast Range and Precipitation. The overnight summary uses all available models. NWS snow level is separate.</p>''', 'html.parser')
            for node in list(comparison.contents): content.append(node)
            for section in evidence: content.append(section)
            if camera: content.append(camera)
        soup.title.string = ('Favorites' if page == 'favorites' else 'Stevens Pass') + ' · Cloud10'
        soup.select_one('meta[name="description"]')['content'] = 'Stevens Pass overnight snowfall forecasts, NWS snow level, and 1/3/5-day model comparison at Brooks 4,800 ft. Actual snowfall is unconfirmed.'
        for link in list(soup.select('link[href="/clone/overnight.css"]')): link.decompose()
        soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/overnight.css'))
        for link in list(soup.select('link[href="/clone/explore.css"]')): link.decompose()
        if page == 'stevens': soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/explore.css'))
        for link in list(soup.select('link[href="/clone/tomorrow.css"]')): link.decompose()
        soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/tomorrow.css'))
        for link in list(soup.select('link[href="/clone/horizon.css"]')): link.decompose()
        soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/horizon.css'))
        for link in soup.select('link[href="/clone/club.css"]'):
            link.decompose()
        soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/club.css'))
        for wordmark in soup.select('.clould-wordmark'):
            wordmark['aria-label'] = 'Cloud10 home'
            for text in list(wordmark.find_all(string=True)):
                if 'Clould' in text: text.replace_with(str(text).replace('Clould', 'Cloud'))
        menu = soup.select_one('.clould-menu')
        if menu:
            menu.clear()
            menu.append(soup.new_tag('img', src='/clone/icons/bars-3.svg', width='24', height='24', alt=''))
        for search in soup.select('.clould-search'): search.decompose()
        footer = soup.select_one('.clould-footer-sources')
        if footer:
            for text in list(footer.find_all(string=True)):
                text.replace_with(str(text).replace('Independent forecasts. Local observations.', 'Model forecasts. Actual snowfall unconfirmed.').replace('Clould10', 'Cloud10'))
        path.write_text(str(soup))

if __name__ == '__main__': apply_layout()
