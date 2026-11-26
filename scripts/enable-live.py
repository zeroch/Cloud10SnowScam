"""Turn the captured visual shell into the live Stevens Pass application.

Run after build-clone.py. Idempotent; original research captures are retained.
"""
import json
import re
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/clone'

def slot(soup, name):
    node = soup.new_tag('div', attrs={'data-live-slot': name, 'class': 'live-slot'})
    node.string = 'Loading live Stevens Pass data…'
    return node

def trim(soup):
    for node in list(soup.select('[data-location-row], [data-edit-location]')):
        if (node.get('data-location-row') or node.get('data-edit-location')) != 'stevenspass':
            node.decompose()
    for text in list(soup.find_all(string=True)):
        if text.parent.name in ('script', 'style'):
            continue
        value = str(text).replace('4,925 ft', '4,800 ft').replace('21 Locations', '1 Location').replace('20 Locations', '1 Location')
        if value != str(text): text.replace_with(value)
    for label in list(soup.select('label')):
        if label.get_text(' ', strip=True) in ['Closest', 'Area Open', 'Next 10 Days', 'Next 15 Days', 'Next 6-10 Days', 'Next 11-15 Days', 'Prev 5 Days', 'Prev 10 Days', 'Prev 15 Days', 'Last 24 Hours']:
            label.decompose()
    for node in list(soup.find_all(string=re.compile('Opening Dec 4'))):
        node.replace_with('Brooks forecast')
    for node in soup.find_all(string=lambda text: text and text.strip() == 'Brooks forecast'):
        node.parent['class'] = ['tw-text-sm', 'text-blue-color']
        for icon in node.parent.parent.select('svg'): icon.decompose()
    for node in list(soup.select('.SnowSummaryZoomInToggle__buttonZoomIn, .SnowSummaryZoomInToggle__buttonZoomOut')):
        node.decompose()

def enable_live():
    for name in ['favorites', 'stevens']:
        path = OUT / (name + '.html')
        soup = BeautifulSoup(path.read_text(), 'html.parser')
        trim(soup)
        if not soup.select_one('link[href="/clone/live.css"]'):
            soup.head.append(soup.new_tag('link', rel='stylesheet', href='/clone/live.css'))
        soup.title.string = ('Favorites' if name == 'favorites' else 'Stevens Pass') + ' — Live Snow Desk'
        soup.select_one('meta[name="description"]')['content'] = 'Live Stevens Pass snowfall, NWAC observations, and 1/3/5-day weather model comparison at Brooks elevation.'
        soup.body['data-live'] = 'true'
        for chart in list(soup.select('.SnowSummary__container')):
            chart.parent.parent.replace_with(slot(soup, 'summary'))
        for section in soup.select('[data-section]'):
            key = section['data-section']
            if key == 'hourly-forecast':
                section.decompose()
                continue
            if key not in ['daily-forecast', 'forecast-range', 'precipitation-by-model']: continue
            if key == 'forecast-range': section['id'] = 'live-models'
            for pills in section.select('header ul'): pills.decompose()
            body = section.select_one('.Card__body')
            body.clear(); body.append(slot(soup, key))
        for heading in list(soup.select('h2')):
            title = heading.get_text(' ', strip=True)
            if title in ['Local Expert', 'Overnight Outlook', 'Right Now']:
                section = heading.find_parent('section')
                if section is not None:
                    body = section.select_one('.Card__body')
                    if body is not None:
                        heading.string = 'Right Now' if title == 'Right Now' else 'Overnight Outlook'
                        body.clear(); body.append(slot(soup, 'stations' if title == 'Right Now' else 'outlook'))
            if title.startswith('Snow Summary Powered'):
                for n in heading.select('a'): n.decompose()
                for n in list(heading.find_all(string=re.compile('Powered by'))): n.extract()
            if title == 'Cams' and not heading.parent.select_one('.live-camera-note'):
                note = soup.new_tag('span', attrs={'class': 'live-camera-note'})
                note.string = 'Reference images · Oct 14, 2026'
                heading.parent.append(note)
        for section in list(soup.select('section')):
            if '15-Day Forecasts and more' in section.get_text(' ', strip=True) and len(section.get_text()) < 2500:
                section.decompose()
        for node in list(soup.find_all(string=re.compile('OpenSnow Forecast System'))):
            block = node.parent
            block.clear()
            block.string = 'Live model forecasts via Open-Meteo · NWAC observations · NWS snow level. See source timestamps above.'
        path.write_text(str(soup))
    path = OUT / 'states.json'
    states = json.loads(path.read_text())
    states['locations'] = [x for x in states['locations'] if x['id'] == 'stevenspass']
    for key in ['edit', 'filter', 'navOpen']:
        if key not in states: continue
        soup = BeautifulSoup(states[key], 'html.parser'); trim(soup); states[key] = str(soup)
    path.write_text(json.dumps(states, ensure_ascii=False, separators=(',', ':')))
    import runpy
    runpy.run_path(str(ROOT / 'scripts/brand-clould10.py'), run_name='__main__')

if __name__ == '__main__': enable_live()
