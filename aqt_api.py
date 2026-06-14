"""
aqt_api.py -- Flask proxy server per AquaTime
Streaming NDJSON con richieste parallele (ThreadPoolExecutor).
"""

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import concurrent.futures
import json
import os
import time

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

# -- Costanti AquaTime --------------------------------------------------------

AQT_BASE = "https://aquatime.it"

AQT_STAGIONI = {
    "2025-2026": "20", "2024-2025": "19", "2023-2024": "18",
    "2022-2023": "17", "2021-2022": "16", "2020-2021": "15",
    "2019-2020": "14", "2018-2019": "13", "2017-2018": "12",
    "2016-2017": "11", "2015-2016": "10", "2014-2015":  "9",
    "2013-2014":  "5", "2012-2013":  "2", "2011-2012":  "1",
    "All Time":   "9999",
}

AQT_CATEGORIE = {
    "RAGAZZI":              "7",
    "JUNIORES":             "8",
    "CADETTI":              "9",
    "ASSOLUTI":             "14",
    "SENIORES":             "15",
    "RAGAZZI 1° Anno": "47",
    "RAGAZZI 2-3° Anno": "48",
    "RAGAZZI 2° Anno": "50",
    "RAGAZZI 3° Anno": "53",
    "JUNIORES 1° Anno": "51",
    "JUNIORES 2° Anno": "52",
    "CADETTI+SENIORES":     "70",
    "Esordienti C1": "1", "Esordienti C2": "2",
    "Esordienti B1": "3", "Esordienti B2": "4",
    "Esordienti A1": "5", "Esordienti A2": "6",
    "Esordienti C": "11", "Esordienti B": "12", "Esordienti A": "13",
}

AQT_GARE = {
    "50 Stile Libero":    "36", "100 Stile Libero":  "32",
    "200 Stile Libero":   "40", "400 Stile Libero":  "47",
    "800 Stile Libero":   "48", "1500 Stile Libero": "49",
    "50 Dorso":           "37", "100 Dorso":         "33",
    "200 Dorso":          "41",
    "50 Rana":            "38", "100 Rana":          "35",
    "200 Rana":           "43",
    "50 Farfalla":        "39", "100 Farfalla":      "34",
    "200 Farfalla":       "42",
    "100 Misti":          "44", "200 Misti":         "45",
    "400 Misti":          "46",
}

VIS_CATS_M = {
    "R1": "RAGAZZI 1° Anno",
    "R2": "RAGAZZI 2° Anno",
    "R3": "RAGAZZI 3° Anno",
    "J1": "JUNIORES 1° Anno",
    "J2": "JUNIORES 2° Anno",
    "CA": "CADETTI",
    "SE": "SENIORES",
    "AS": "ASSOLUTI",
}

VIS_CATS_F = {
    "R1": "RAGAZZI 1° Anno",
    "R2": "RAGAZZI 2° Anno",
    "J1": "JUNIORES 1° Anno",
    "J2": "JUNIORES 2° Anno",
    "CA": "CADETTI",
    "SE": "SENIORES",
    "AS": "ASSOLUTI",
}

VIS_GARE = {
    "50 Stile Libero", "100 Stile Libero", "200 Stile Libero",
    "400 Stile Libero", "800 Stile Libero", "1500 Stile Libero",
    "50 Dorso",  "100 Dorso",  "200 Dorso",
    "50 Rana",   "100 Rana",   "200 Rana",
    "50 Farfalla", "100 Farfalla", "200 Farfalla",
    "100 Misti", "200 Misti", "400 Misti",
}

# -- Login --------------------------------------------------------------------

def aqt_login(session, utente, password):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Referer": AQT_BASE + "/",
        "Accept-Language": "it-IT,it;q=0.9",
    }
    session.headers.update(headers)
    session.get(AQT_BASE, timeout=15)
    r = session.post(
        AQT_BASE + "/login.php",
        data={"uname": utente, "passw": password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
        allow_redirects=True,
    )
    return r.status_code == 200

# -- HTML parser --------------------------------------------------------------

def parse_table(html, gara, categoria, sesso_str, stagione, vasca_override=None):
    soup = BeautifulSoup(html, "html.parser")
    target = None
    for tbl in soup.find_all("table", class_="datatable"):
        ths = [th.get_text(strip=True).lower() for th in tbl.find_all("th")]
        if any(k in " ".join(ths) for k in ["pos", "atleta", "tempo"]):
            if not target or len(tbl.find_all("tr")) > len(target.find_all("tr")):
                target = tbl
    if not target:
        return []
    trs = target.find_all("tr")
    if len(trs) < 2:
        return []
    hdrs = [th.get_text(strip=True) for th in trs[0].find_all(["th", "td"])]
    rows = []
    for tr in trs[1:]:
        cells = [td.get_text(strip=True) for td in tr.find_all(["td", "th"])]
        if not cells or all(c == "" for c in cells):
            continue
        d = {hdrs[i]: cells[i] for i in range(min(len(hdrs), len(cells)))}

        def g(*keys, _d=d):
            for k in keys:
                for hk, hv in _d.items():
                    if k.lower() in hk.lower() and str(hv).strip():
                        return str(hv).strip()
            return ""

        atleta = g("atleta") or (cells[1] if len(cells) > 1 else "")
        if not atleta:
            continue
        vasca_val = vasca_override or g("vasca") or (cells[7] if len(cells) > 7 else "")
        rows.append({
            "Pos":        g("pos") or (cells[0] if cells else ""),
            "Atleta":     atleta,
            "Anno":       g("anno") or (cells[2] if len(cells) > 2 else ""),
            "Societa":    g("socie") or (cells[3] if len(cells) > 3 else ""),
            "Data":       g("data") or (cells[4] if len(cells) > 4 else ""),
            "Tempo":      g("tempo") or (cells[5] if len(cells) > 5 else ""),
            "PtFINA":     g("fina", "pt.") or (cells[6] if len(cells) > 6 else ""),
            "Vasca":      vasca_val,
            "Crono":      g("crono") or (cells[8] if len(cells) > 8 else ""),
            "_gara":      gara,
            "_categoria": categoria,
            "_sesso":     sesso_str,
            "_stagione":  stagione,
        })
    return rows

# -- Worker per richieste parallele -------------------------------------------

def fetch_task(task, cookies, headers, stagione):
    cat, gara, sesso_str, vasca_id, vasca_lbl, stag_id = task
    cat_id   = AQT_CATEGORIE.get(cat, "9")
    gara_id  = AQT_GARE.get(gara, "43")
    sesso_id = "1" if sesso_str == "Maschi" else "2"
    url = (
        f"{AQT_BASE}/records.php"
        f"?Stagione={stag_id}&Categoria={cat_id}&Gara={gara_id}"
        f"&tipoG=2&Vasca={vasca_id}&Sesso={sesso_id}"
        f"&TipoTempi=2&SoloSoc=0&comi=1&page=1"
    )
    try:
        r = requests.get(url, cookies=cookies, headers=headers, timeout=12)
        rows = parse_table(r.text, gara, cat, sesso_str, stagione, vasca_lbl)
        return rows, None
    except Exception as e:
        return [], f"{cat}|{gara}|{sesso_str}|{vasca_lbl}: {e}"

# -- Endpoint: cerca (streaming NDJSON + parallel) ----------------------------

@app.route("/api/aqt/cerca", methods=["POST", "OPTIONS"])
def cerca():
    if request.method == "OPTIONS":
        return "", 204
    data     = request.get_json(force=True)
    utente   = data.get("utente", "").strip()
    password = data.get("password", "").strip()
    stagione = data.get("stagione", "2025-2026")

    if not utente or not password:
        return jsonify({"error": "Credenziali mancanti"}), 400

    def generate():
        stag_id = AQT_STAGIONI.get(stagione, "20")
        session = requests.Session()

        yield json.dumps({"type": "status", "msg": "Login su aquatime.it..."}) + "\n"
        try:
            ok = aqt_login(session, utente, password)
            if not ok:
                yield json.dumps({"type": "error", "msg": "Login fallito"}) + "\n"
                return
        except Exception as e:
            yield json.dumps({"type": "error", "msg": f"Errore login: {e}"}) + "\n"
            return

        # Cookies e headers per i thread paralleli
        cookies = dict(session.cookies)
        req_headers = dict(session.headers)

        cats_m   = set(VIS_CATS_M.values())
        cats_f   = set(VIS_CATS_F.values())
        cats_vis = cats_m | cats_f
        cats  = [c for c in AQT_CATEGORIE if c in cats_vis]
        gares = [g for g in AQT_GARE if g in VIS_GARE]

        VASCHE = [("1", "25 m"), ("2", "50 m")]
        tasks = []
        for g in gares:
            for c in cats:
                for vasca_id, vasca_lbl in VASCHE:
                    if c in cats_m:
                        tasks.append((c, g, "Maschi",  vasca_id, vasca_lbl, stag_id))
                    if c in cats_f:
                        tasks.append((c, g, "Femmine", vasca_id, vasca_lbl, stag_id))

        totale = len(tasks)
        tutti  = []
        errori = []
        step   = 0

        yield json.dumps({"type": "status", "msg": f"Avvio download ({totale} richieste, 4 parallele)..."}) + "\n"

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            future_map = {
                executor.submit(fetch_task, t, cookies, req_headers, stagione): t
                for t in tasks
            }
            for future in concurrent.futures.as_completed(future_map):
                step += 1
                pct  = int(step / totale * 100)
                t    = future_map[future]
                try:
                    rows, err = future.result()
                    tutti.extend(rows)
                    if err:
                        errori.append(err)
                except Exception as e:
                    errori.append(str(e))
                    rows = []

                yield json.dumps({
                    "type":     "progress",
                    "pct":      pct,
                    "step":     step,
                    "total":    totale,
                    "cat":      t[0],
                    "gara":     t[1],
                    "sesso":    t[2],
                    "vasca":    t[4],
                    "found":    len(tutti),
                    "new_rows": rows,
                }) + "\n"

        yield json.dumps({
            "type":     "done",
            "totale":   len(tutti),
            "errori":   errori,
            "stagione": stagione,
        }) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"X-Accel-Buffering": "no"},
    )

# -- Endpoint: debug singola combo -------------------------------------------

@app.route("/api/aqt/debug", methods=["POST", "OPTIONS"])
def debug_combo():
    if request.method == "OPTIONS":
        return "", 204
    """Testa una singola combinazione e restituisce quante righe trova per tipoG=0 e tipoG=2."""
    data     = request.get_json(force=True)
    utente   = data.get("utente", "").strip()
    password = data.get("password", "").strip()
    cat      = data.get("cat", "CADETTI")
    gara     = data.get("gara", "100 Rana")
    sesso    = data.get("sesso", "Maschi")
    vasca_id = data.get("vasca", "2")
    stagione = data.get("stagione", "2025-2026")

    session = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Referer": AQT_BASE + "/",
    }
    session.headers.update(headers)
    session.get(AQT_BASE, timeout=15)
    session.post(AQT_BASE + "/login.php",
                 data={"uname": utente, "passw": password},
                 headers={"Content-Type": "application/x-www-form-urlencoded"},
                 timeout=15, allow_redirects=True)

    stag_id  = AQT_STAGIONI.get(stagione, "20")
    cat_id   = AQT_CATEGORIE.get(cat, "9")
    gara_id  = AQT_GARE.get(gara, "35")
    sesso_id = "1" if sesso == "Maschi" else "2"
    cookies  = dict(session.cookies)
    req_h    = dict(session.headers)

    results = {}
    for tipo in [0, 2]:
        url = (f"{AQT_BASE}/records.php"
               f"?Stagione={stag_id}&Categoria={cat_id}&Gara={gara_id}"
               f"&tipoG={tipo}&Vasca={vasca_id}&Sesso={sesso_id}"
               f"&TipoTempi=2&SoloSoc=0&comi=1&page=1")
        try:
            r = requests.get(url, cookies=cookies, headers=req_h, timeout=12)
            rows = parse_table(r.text, gara, cat, sesso, stagione, None)
            # Conta anche quante tabelle ci sono nella pagina
            from bs4 import BeautifulSoup as BS
            soup = BS(r.text, "html.parser")
            tbls = soup.find_all("table")
            results[f"tipoG_{tipo}"] = {
                "rows": len(rows),
                "sample": rows[:2] if rows else [],
                "tables_in_page": len(tbls),
                "table_classes": list({t.get("class", ["none"])[0] for t in tbls}),
                "url": url,
            }
        except Exception as e:
            results[f"tipoG_{tipo}"] = {"error": str(e)}

    return jsonify(results)

# -- Endpoint: stagioni -------------------------------------------------------

@app.route("/api/aqt/stagioni", methods=["GET"])
def stagioni():
    return jsonify(list(AQT_STAGIONI.keys()))

# -- Main ---------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    print(f"AquaTime API server avviato su http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
