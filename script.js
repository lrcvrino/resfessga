/* =====================================================================
 * Gestor de Resultados Deportivos
 * Análisis de resultados de Salvamento y Socorrismo a partir de CSV.
 *
 * Flujo:
 *   1. Se carga un CSV (exportado por el software de competición).
 *   2. Se clasifica a cada deportista/equipo por su resultado OFICIAL.
 *   3. Se generan resúmenes listos para Redes, WhatsApp, Prensa y Medallero.
 * ===================================================================== */

'use strict';

/* ---------------------------------------------------------------------
 * Constantes: nombres de columna del CSV de origen.
 * ------------------------------------------------------------------- */
const COL = {
    dni:           'DNI',
    nombre:        'Nombre',
    apellidos:     'Apellidos',
    anio:          'Año',
    sexo:          'Sexo',
    club:          'Club',
    competicion:   'Competición',
    prueba:        'Prueba',
    agrupacion:    'Agrupación',
    categoria:     'Categoría',
    tipoSerie:     'Tipo Serie',
    ronda:         'Ronda',
    tiempo:        'Tiempo',
    posicion:      'Posición',
    exclusion:     'Exclusión',
    descalificado: 'Descalificado',
    dorsal:        'Dorsal'
};

const REQUIRED_COLUMNS = [COL.club, COL.prueba, COL.categoria, COL.posicion];

/* Estado global de la aplicación */
const state = {
    entries: [],       // Competidores ya clasificados (1 fila por competidor y prueba)
    clubs: [],         // Lista de clubes detectados
    competition: '',   // Nombre de la competición
    medalsHtml: ''     // HTML cacheado del medallero para la vista previa
};

/* Modales de Bootstrap */
let wizardModal, previewModal, copyToast;

/* =====================================================================
 * Inicialización de la interfaz
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    const fileInput   = $('fileInput');
    const clubSelect  = $('clubSelect');
    const topFilter   = $('topFilter');
    const btnNextStep = $('btnNextStep');
    const btnPrevStep = $('btnPrevStep');
    const btnGenerate = $('btnGenerate');
    const step1       = $('wizardStep1');
    const step2       = $('wizardStep2');
    const fileStatus  = $('fileStatus');

    wizardModal  = new bootstrap.Modal($('wizardModal'));
    previewModal = new bootstrap.Modal($('previewModal'));
    copyToast    = new bootstrap.Toast($('copyToast'));

    /* --- Cambio de tema claro / oscuro --- */
    const themeToggle = $('themeToggle');
    const themeIcon   = $('themeIcon');
    themeToggle.addEventListener('click', () => {
        const html = document.documentElement;
        const isDark = html.getAttribute('data-bs-theme') === 'dark';
        html.setAttribute('data-bs-theme', isDark ? 'light' : 'dark');
        themeIcon.className = isDark ? 'bi bi-moon-stars-fill' : 'bi bi-sun-fill';
    });

    /* --- Paso 1: carga del archivo --- */
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length === 0) {
            resetFileStatus(fileStatus, btnNextStep);
            return;
        }
        setStatus(fileStatus, 'Procesando archivo…', 'text-primary');
        btnNextStep.disabled = true;
        handleFileUpload(e.target.files[0], fileStatus, btnNextStep, clubSelect);
    });

    btnNextStep.addEventListener('click', () => {
        step1.classList.add('d-none');
        step2.classList.remove('d-none');
    });

    btnPrevStep.addEventListener('click', () => {
        step2.classList.add('d-none');
        step1.classList.remove('d-none');
    });

    clubSelect.addEventListener('change', (e) => {
        btnGenerate.disabled = !e.target.value;
    });

    btnGenerate.addEventListener('click', () => {
        generateSummaries();
        wizardModal.hide();
        document.getElementById('welcomeArea').classList.add('d-none');
        resetWizard();
    });

    function resetWizard() {
        setTimeout(() => {
            step2.classList.add('d-none');
            step1.classList.remove('d-none');
            clubSelect.value = '';
            topFilter.value = '16';
            btnGenerate.disabled = true;
            fileInput.value = '';
            resetFileStatus(fileStatus, btnNextStep);
        }, 400);
    }

    /* --- Botones Copiar --- */
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const textarea = document.getElementById(e.currentTarget.dataset.target);
            copyToClipboard(textarea.value);
        });
    });

    /* --- Botones Vista previa --- */
    document.querySelectorAll('.preview-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const text   = document.getElementById(e.currentTarget.dataset.target).value;
            const format = e.currentTarget.dataset.format;
            renderPreview(text, format);
        });
    });
});

/* --- Utilidades de estado de la interfaz --- */
function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = 'small ' + (cls || 'text-muted');
}
function resetFileStatus(el, btnNext) {
    setStatus(el, 'Esperando archivo CSV…', 'text-muted');
    btnNext.disabled = true;
}

function copyToClipboard(text) {
    const done = () => copyToast.show();
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
        fallbackCopy(text, done);
    }
}
function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    done();
}

/* =====================================================================
 * Lectura y parseo del CSV
 * ===================================================================== */
function handleFileUpload(file, fileStatus, btnNext, clubSelect) {
    const reader = new FileReader();
    reader.onload = (e) => {
        let text;
        try {
            text = decodeBuffer(e.target.result);
        } catch (err) {
            setStatus(fileStatus, 'No se pudo leer el archivo (codificación no reconocida).', 'text-danger');
            return;
        }

        Papa.parse(text, {
            header: true,
            skipEmptyLines: 'greedy',
            delimiter: detectDelimiter(text),
            complete: (results) => {
                try {
                    const count = processParsedData(results.data, clubSelect);
                    setStatus(fileStatus, `Archivo cargado: ${count} registros analizados.`, 'text-success');
                    btnNext.disabled = false;
                } catch (err) {
                    setStatus(fileStatus, err.message, 'text-danger');
                    btnNext.disabled = true;
                }
            },
            error: (err) => {
                console.error('Error al parsear el CSV:', err);
                setStatus(fileStatus, 'Error al leer el contenido del archivo.', 'text-danger');
            }
        });
    };
    reader.onerror = () => setStatus(fileStatus, 'No se pudo abrir el archivo.', 'text-danger');
    reader.readAsArrayBuffer(file);
}

/**
 * Decodifica un ArrayBuffer detectando la codificación por su BOM.
 * Los exports habituales de este software vienen en UTF-16LE, pero
 * también se admiten UTF-8 (con o sin BOM) y UTF-16BE.
 */
function decodeBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let encoding = 'utf-8';
    let offset = 0;

    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        encoding = 'utf-16le'; offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        encoding = 'utf-16be'; offset = 2;
    } else if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        encoding = 'utf-8'; offset = 3;
    } else {
        // Heurística: si hay muchos bytes nulos en posiciones pares → UTF-16LE sin BOM
        let nulls = 0;
        const sample = Math.min(bytes.length, 200);
        for (let i = 1; i < sample; i += 2) if (bytes[i] === 0x00) nulls++;
        if (nulls > sample / 4) encoding = 'utf-16le';
    }

    return new TextDecoder(encoding).decode(bytes.subarray(offset));
}

/** Detecta el delimitador más probable a partir de la primera línea. */
function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const candidates = [';', ',', '\t', '|'];
    let best = ';', bestCount = -1;
    candidates.forEach(d => {
        const count = firstLine.split(d).length - 1;
        if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
}

/** Limpia claves (BOM/espacios) y valores de una fila. */
function normalizeKeys(obj) {
    const clean = {};
    for (const key in obj) {
        const cleanKey = key.replace(/^﻿/, '').trim();
        clean[cleanKey] = (obj[key] ?? '').toString().trim();
    }
    return clean;
}

/* =====================================================================
 * Clasificación de los resultados
 * ===================================================================== */

/** Nivel de la ronda: la Final manda sobre la Semifinal y esta sobre la Preliminar. */
function seriesLevel(row) {
    const t = (row[COL.tipoSerie] || '').toLowerCase();
    if (t.includes('final') && !t.includes('semi')) return 3;
    if (t.includes('semi')) return 2;
    return 1; // Preliminar / Serie / clasificatoria
}

/** ¿El resultado no es válido para el ranking (DQ, baja, no finaliza, no presentado)? */
function isDisqualified(row) {
    const desc = (row[COL.descalificado] || '').toLowerCase();
    const excl = (row[COL.exclusion] || '').trim();
    return desc.startsWith('s') || desc.startsWith('y') || excl !== '';
}

/** Etiqueta legible del motivo de exclusión. */
function statusLabel(row) {
    const excl = (row[COL.exclusion] || '').toLowerCase();
    if (excl.includes('no finaliza'))  return 'No finalizó';
    if (excl.includes('no present'))   return 'No presentado/a';
    if (excl.includes('baja'))         return 'Baja';
    if (excl.includes('descalif'))     return 'Descalificado/a';
    return isDisqualified(row) ? 'Descalificado/a' : '';
}

/**
 * Determina si una fila corresponde a un equipo/relevo.
 * NO depende del DNI (que puede venir vacío por privacidad): un relevo no
 * tiene nombre de persona, mientras que un deportista individual sí lo tiene.
 */
function isTeamRow(row) {
    if (row[COL.dni]) return false;                          // tiene DNI → deportista
    if (row[COL.nombre] || row[COL.apellidos]) return false; // tiene nombre → deportista
    return true;                                             // sin DNI ni nombre → equipo/relevo
}

/**
 * Identificador único de un competidor dentro de su prueba, para deduplicar
 * (preliminar/final). Usa el DNI si está presente; si no, recurre al nombre
 * completo y al año de nacimiento, de modo que funciona con el DNI vacío.
 */
function competitorId(row, isTeam) {
    if (isTeam) {
        return `T:${row[COL.club]}:${row[COL.dorsal] || row[COL.agrupacion]}`;
    }
    if (row[COL.dni]) return `A:${row[COL.dni]}`;
    return `A:${formatName(row)}|${row[COL.anio] || ''}`;
}

/** Deriva el sexo de un equipo/relevo a partir de la agrupación. */
function deriveSex(row) {
    const declared = (row[COL.sexo] || '').trim();
    if (declared) return declared.toUpperCase();
    const agru = (row[COL.agrupacion] || '').toLowerCase();
    if (agru.includes('masculin')) return 'M';
    if (agru.includes('femenin'))  return 'F';
    if (agru.includes('mixt'))     return 'X';
    return '';
}

function parsePosition(row) {
    const n = parseInt(row[COL.posicion], 10);
    return Number.isFinite(n) ? n : 9999;
}

/**
 * Convierte las filas del CSV en una lista de competidores clasificados.
 * Cada competidor aparece UNA sola vez por prueba, con su resultado oficial
 * (la ronda de mayor nivel disputada) y su posición real del CSV.
 */
function processParsedData(rawData, clubSelect) {
    const rows = rawData.map(normalizeKeys)
        .filter(r => r[COL.prueba] && r[COL.club]);

    if (rows.length === 0) {
        throw new Error('El archivo no contiene registros válidos.');
    }
    const missing = REQUIRED_COLUMNS.filter(c => !(c in rows[0]));
    if (missing.length) {
        throw new Error('Faltan columnas en el CSV: ' + missing.join(', '));
    }

    // Agrupamos por prueba + sexo + categoría (una competición real)
    const groups = new Map();
    rows.forEach(row => {
        const isTeam = isTeamRow(row);
        const sex = deriveSex(row);
        const key = `${row[COL.prueba]}||${sex}||${row[COL.categoria]}`;
        const id = competitorId(row, isTeam);

        const level = seriesLevel(row);
        const pos = parsePosition(row);

        if (!groups.has(key)) groups.set(key, new Map());
        const bucket = groups.get(key);
        const current = bucket.get(id);

        // Nos quedamos con la ronda de mayor nivel; a igualdad, mejor posición.
        const better = !current ||
            level > current.level ||
            (level === current.level && pos < current.pos);

        if (better) {
            bucket.set(id, { row, isTeam, sex, level, pos });
        }
    });

    // Aplanamos a la lista final de competidores
    const entries = [];
    let competition = '';
    groups.forEach(bucket => {
        bucket.forEach(({ row, isTeam, sex, pos }) => {
            competition = competition || row[COL.competicion];
            entries.push({
                id:          isTeam ? teamLabel(sex) : formatName(row),
                isTeam,
                sex,
                club:        row[COL.club],
                competition: row[COL.competicion] || '',
                prueba:      row[COL.prueba] || 'Prueba',
                categoria:   row[COL.categoria] || 'General',
                position:    pos,
                disqualified: isDisqualified(row),
                status:      statusLabel(row)
            });
        });
    });

    state.entries = entries;
    state.competition = competition || 'Competición';
    state.clubs = [...new Set(entries.map(e => e.club))].sort((a, b) => a.localeCompare(b, 'es'));

    // Rellenamos el desplegable de clubes
    clubSelect.innerHTML = '<option value="">— Elige un club —</option>';
    state.clubs.forEach(club => {
        const opt = document.createElement('option');
        opt.value = club;
        opt.textContent = club;
        clubSelect.appendChild(opt);
    });

    return rows.length;
}

/* =====================================================================
 * Formato de textos (nombres, categorías, ordinales)
 * ===================================================================== */

const MINOR_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'das', 'dos', 'o', 'a']);

/** Convierte un texto en MAYÚSCULAS a "Tipo Título" respetando conectores. */
function toTitleCase(str) {
    if (!str) return '';
    return str.toLowerCase().split(/\s+/).map((word, i) => {
        if (i > 0 && MINOR_WORDS.has(word)) return word;
        return word.replace(/^[\p{L}]/u, ch => ch.toUpperCase());
    }).join(' ').trim();
}

function formatName(row) {
    const nombre = toTitleCase(row[COL.nombre]);
    const apellidos = toTitleCase(row[COL.apellidos]);
    return (nombre + ' ' + apellidos).trim();
}

function teamLabel(sex) {
    if (sex === 'F') return 'Equipo femenino';
    if (sex === 'M') return 'Equipo masculino';
    if (sex === 'X') return 'Equipo mixto';
    return 'Equipo';
}

/** Medalla para el podio; posición numérica en el resto de casos. */
function medalFor(position) {
    if (position === 1) return '🥇';
    if (position === 2) return '🥈';
    if (position === 3) return '🥉';
    return `${position}.º`;
}

/** Ordinal femenino (concuerda con "posición"). */
function ordinalF(n) {
    return `${n}.ª`;
}

/** Ordinal concordado con el sexo de la persona/equipo. */
function ordinalPerson(n, sex) {
    return sex === 'F' ? `${n}.ª` : `${n}.º`;
}

/** Palabra de la categoría de sexo. */
function sexWord(sex) {
    if (sex === 'F') return 'Femenino';
    if (sex === 'M') return 'Masculino';
    if (sex === 'X') return 'Mixto';
    return 'Absoluto';
}

/** Orden estable Femenino → Masculino → Mixto. */
function sexOrder(sex) {
    return { F: 0, M: 1, X: 2 }[sex] ?? 3;
}

/** Medalla con artículo (para textos en prosa). */
function medalWord(position) {
    if (position === 1) return 'el oro';
    if (position === 2) return 'la plata';
    if (position === 3) return 'el bronce';
    return '';
}

/** Une cláusulas con comas y una "y" final. */
const joinClauses = joinNames;

/* =====================================================================
 * Generación de resúmenes
 * ===================================================================== */
function generateSummaries() {
    const club = document.getElementById('clubSelect').value;
    const topLimit = parseInt(document.getElementById('topFilter').value, 10) || 16;
    if (!club) return;

    const clubEntries = state.entries
        .filter(e => e.club === club)
        .sort((a, b) => a.position - b.position);

    const inTop  = clubEntries.filter(e => e.position <= topLimit);
    const outTop = clubEntries.filter(e => e.position > topLimit);

    const individuals = groupByCategory(inTop.filter(e => !e.isTeam));
    const teams       = groupByCategory(inTop.filter(e => e.isTeam));

    // Menciones especiales: deportistas fuera del top que NO aparecen ya arriba.
    const highlighted = new Set(inTop.filter(e => !e.isTeam).map(e => e.id));
    const mentions = [...new Set(
        outTop.filter(e => !e.isTeam && !highlighted.has(e.id)).map(e => e.id)
    )];

    const ctx = { club, competition: state.competition, individuals, teams, mentions };

    document.getElementById('socialText').value   = buildSocialText(ctx);
    document.getElementById('whatsappText').value = buildWhatsAppText(ctx);
    document.getElementById('pressText').value    = buildPressText(ctx);

    const medals = buildMedalsData(clubEntries);
    document.getElementById('medalsText').value = buildMedalsText(medals, club);
    state.medalsHtml = buildMedalsHtml(medals, club);

    renderStats(clubEntries, medals);

    document.getElementById('resultsArea').classList.remove('d-none');
    document.getElementById('resultsTitle').textContent = club;
    document.getElementById('resultsSubtitle').textContent = state.competition;
}

/** Agrupa por Categoría → Prueba, manteniendo el orden por posición. */
function groupByCategory(items) {
    const byCat = {};
    items.forEach(item => {
        const cat = item.categoria || 'General';
        const prueba = item.prueba || 'General';
        if (!byCat[cat]) byCat[cat] = {};
        if (!byCat[cat][prueba]) byCat[cat][prueba] = [];
        byCat[cat][prueba].push(item);
    });
    return byCat;
}

function hasContent(grouped) {
    return Object.keys(grouped).length > 0;
}

/* --- Resumen para Redes Sociales --- */
function buildSocialText(ctx) {
    const lines = [];
    lines.push(`🔥 ¡Gran actuación del ${ctx.club} en el ${ctx.competition}! 🔥`);
    lines.push('');

    if (hasContent(ctx.individuals) || hasContent(ctx.teams)) {
        lines.push('Estos fueron nuestros mejores resultados:');
        lines.push('');
        if (hasContent(ctx.individuals)) {
            lines.push('👤 INDIVIDUALES');
            lines.push(renderRankedList(ctx.individuals));
        }
        if (hasContent(ctx.teams)) {
            lines.push('👥 RELEVOS Y EQUIPOS');
            lines.push(renderTeamList(ctx.teams));
        }
    }

    if (ctx.mentions.length) {
        lines.push(mentionText(ctx.mentions, '👏'));
        lines.push('');
    }

    lines.push('¡Enhorabuena a todo el equipo por el esfuerzo y la representación! 💪');
    lines.push('');
    lines.push(`#Salvamento #Socorrismo #${ctx.club.replace(/[^\p{L}\p{N}]/gu, '')}`);
    return lines.join('\n').trim();
}

/* --- Resumen para WhatsApp --- */
function buildWhatsAppText(ctx) {
    const lines = [];
    lines.push(`🏆 *RESULTADOS · ${ctx.club.toUpperCase()}*`);
    lines.push(`📍 _${ctx.competition}_`);
    lines.push('');

    if (hasContent(ctx.individuals)) {
        lines.push('👤 *RESULTADOS INDIVIDUALES*');
        lines.push(renderRankedList(ctx.individuals, '*', '_'));
    }
    if (hasContent(ctx.teams)) {
        lines.push('👥 *RELEVOS Y EQUIPOS*');
        lines.push(renderTeamList(ctx.teams, '*'));
    }
    if (!hasContent(ctx.individuals) && !hasContent(ctx.teams)) {
        lines.push('El club compitió con gran entrega en todas sus pruebas.');
        lines.push('');
    }

    if (ctx.mentions.length) {
        lines.push(mentionText(ctx.mentions, '👉'));
        lines.push('');
    }

    lines.push('💪 ¡Enhorabuena a todo el equipo! 🌊');
    return lines.join('\n').trim();
}

/**
 * Renderiza la lista jerárquica Categoría → Prueba → competidores.
 * `catMark` y `pruebaMark` permiten aplicar el formato de negrita/cursiva
 * de WhatsApp (que en Redes se ignora).
 */
function renderRankedList(grouped, catMark = '', pruebaMark = '') {
    const out = [];
    const cats = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'es'));
    cats.forEach(cat => {
        out.push(`🔹 ${catMark}Categoría ${toTitleCase(cat)}${catMark}`);
        Object.keys(grouped[cat]).sort((a, b) => a.localeCompare(b, 'es')).forEach(prueba => {
            out.push(`   🔸 ${pruebaMark}${prueba}${pruebaMark}`);
            grouped[cat][prueba].forEach(item => {
                if (item.disqualified) {
                    out.push(`      ▫️ ${item.id} — ${item.status || 'Descalificado/a'}`);
                } else {
                    out.push(`      ${medalFor(item.position)} ${item.id}`);
                }
            });
        });
        out.push('');
    });
    return out.join('\n');
}

/**
 * Renderiza los relevos/equipos: Categoría (encabezado) y, en cada línea,
 * la prueba con su sexo para una lectura rápida y sin ambigüedades.
 */
function renderTeamList(grouped, catMark = '') {
    const out = [];
    Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'es')).forEach(cat => {
        out.push(`🔹 ${catMark}Categoría ${toTitleCase(cat)}${catMark}`);

        const items = [];
        Object.keys(grouped[cat]).forEach(prueba => grouped[cat][prueba].forEach(it => items.push(it)));
        items.sort((a, b) => a.prueba.localeCompare(b.prueba, 'es') || sexOrder(a.sex) - sexOrder(b.sex));

        items.forEach(it => {
            if (it.disqualified) {
                out.push(`   ▫️ ${it.prueba} · ${sexWord(it.sex)} — ${it.status || 'Descalificado'}`);
            } else {
                out.push(`   ${medalFor(it.position)} ${it.prueba} · ${sexWord(it.sex)}`);
            }
        });
        out.push('');
    });
    return out.join('\n');
}

function mentionText(names, emoji) {
    const list = joinNames(names);
    return `\n${emoji} Mención especial para ${list}, que también dieron lo mejor de sí representando al club. ¡Seguimos! 🚀`;
}

/* --- Nota de Prensa --- */
function buildPressText(ctx) {
    const p = [];
    p.push('NOTA DE PRENSA');
    p.push('');
    p.push(`Destacada actuación del ${ctx.club} en el ${ctx.competition}`);
    p.push('');
    p.push(`El ${ctx.club} firmó una notable participación en el ${ctx.competition}, ` +
           `donde sus deportistas demostraron un excelente nivel en las diferentes pruebas.`);
    p.push('');

    let hasResults = false;

    if (hasContent(ctx.individuals)) {
        hasResults = true;
        p.push('En la competición individual, estos fueron los resultados más destacados:');
        p.push(renderPressIndividuals(ctx.individuals));
    }

    if (hasContent(ctx.teams)) {
        hasResults = true;
        p.push('En las pruebas de relevos, el balance por equipos fue el siguiente:');
        p.push(renderPressTeams(ctx.teams));
    }

    if (!hasResults) {
        p.push('El equipo compitió con determinación en todas sus pruebas.');
        p.push('');
    }

    if (ctx.mentions.length) {
        p.push(`Asimismo, la entidad quiere reconocer el esfuerzo de ${joinNames(ctx.mentions)}, ` +
               `que completaron una gran actuación defendiendo los colores del club.`);
        p.push('');
    }

    p.push(`Desde la dirección del club se valora muy positivamente el rendimiento de toda la ` +
           `expedición, que ya mira hacia los próximos compromisos del calendario deportivo.`);
    return p.join('\n').trim();
}

function renderPressIndividuals(grouped) {
    const out = [];
    Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'es')).forEach(cat => {
        // Reunimos todos los resultados de cada deportista dentro de la categoría
        const byAthlete = {};
        const sexOf = {};
        Object.keys(grouped[cat]).forEach(prueba => {
            grouped[cat][prueba].forEach(item => {
                (byAthlete[item.id] = byAthlete[item.id] || []).push(item);
                sexOf[item.id] = item.sex;
            });
        });

        if (Object.keys(byAthlete).length === 0) return;
        out.push(`En categoría ${toTitleCase(cat)}:`);
        Object.keys(byAthlete).forEach(name => {
            out.push(`  · ${describeAthlete(name, sexOf[name], byAthlete[name])}`);
        });
        out.push('');
    });
    return out.join('\n');
}

/** Frase única y compacta con todos los resultados de un deportista. */
function describeAthlete(name, sex, items) {
    const medals = [], positions = [], dq = [];
    items.forEach(it => {
        if (it.disqualified) dq.push(it.prueba);
        else if (it.position <= 3) medals.push(`${medalWord(it.position)} en ${it.prueba}`);
        else positions.push(`${ordinalPerson(it.position, sex)} en ${it.prueba}`);
    });

    const parts = [];
    if (medals.length)    parts.push(`logró ${joinClauses(medals)}`);
    if (positions.length) parts.push(`finalizó ${joinClauses(positions)}`);
    if (dq.length)        parts.push(`${sex === 'F' ? 'fue descalificada' : 'fue descalificado'} en ${joinClauses(dq)}`);

    // Cada parte es una oración con su propio verbo: las unimos con "; "
    // para no encadenar varias "y" seguidas.
    return `${name} ${parts.join('; ')}.`;
}

/**
 * Balance por equipos agrupado por categoría y sexo: una sola frase por
 * equipo, con las medallas y puestos resumidos (sin repetir la prueba).
 */
function renderPressTeams(grouped) {
    const out = [];
    Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'es')).forEach(cat => {
        const bySex = {};
        Object.keys(grouped[cat]).forEach(prueba => {
            grouped[cat][prueba].forEach(item => {
                (bySex[item.sex] = bySex[item.sex] || []).push(item);
            });
        });
        Object.keys(bySex).sort((a, b) => sexOrder(a) - sexOrder(b)).forEach(sex => {
            out.push(`  · ${describeTeam(sex, cat, bySex[sex])}`);
        });
    });
    out.push('');
    return out.join('\n');
}

function describeTeam(sex, cat, items) {
    const gold = [], silver = [], bronze = [], others = [], dq = [];
    items.forEach(it => {
        if (it.disqualified) dq.push(it.prueba);
        else if (it.position === 1) gold.push(it.prueba);
        else if (it.position === 2) silver.push(it.prueba);
        else if (it.position === 3) bronze.push(it.prueba);
        else others.push(`un ${it.position}.º puesto en ${it.prueba}`);
    });

    const medalClause = (pruebas, singular, plural) => pruebas.length === 1
        ? `${singular} en ${pruebas[0]}`
        : `${pruebas.length} ${plural} (${joinClauses(pruebas)})`;

    const parts = [];
    if (gold.length)   parts.push(medalClause(gold, 'el oro', 'oros'));
    if (silver.length) parts.push(medalClause(silver, 'la plata', 'platas'));
    if (bronze.length) parts.push(medalClause(bronze, 'el bronce', 'bronces'));
    others.forEach(o => parts.push(o));

    const label = `El equipo ${sexWord(sex).toLowerCase()} (${toTitleCase(cat)})`;
    let sentence = parts.length ? `${label} logró ${joinClauses(parts)}` : `${label} completó su participación`;
    if (dq.length) {
        sentence += parts.length
            ? `, además de una descalificación en ${joinClauses(dq)}`
            : `, con descalificación en ${joinClauses(dq)}`;
    }
    return sentence + '.';
}

function joinNames(names) {
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' y ' + names[names.length - 1];
}

/* =====================================================================
 * Medallero
 * ===================================================================== */
function buildMedalsData(clubEntries) {
    const medalists = clubEntries.filter(e => !e.disqualified && e.position >= 1 && e.position <= 3);

    const empty = () => ({ oro: 0, plata: 0, bronce: 0, total: 0 });
    const totals = empty();
    const byCat = {};
    const byPrueba = {};

    medalists.forEach(m => {
        const type = m.position === 1 ? 'oro' : (m.position === 2 ? 'plata' : 'bronce');
        const cat = toTitleCase(m.categoria);
        const prueba = m.prueba;

        if (!byCat[cat]) byCat[cat] = empty();
        if (!byPrueba[prueba]) byPrueba[prueba] = empty();

        totals[type]++; totals.total++;
        byCat[cat][type]++; byCat[cat].total++;
        byPrueba[prueba][type]++; byPrueba[prueba].total++;
    });

    return { totals, byCat, byPrueba, medalists };
}

function buildMedalsText(data, club) {
    const lines = [];
    lines.push(`🏅 MEDALLERO · ${club.toUpperCase()}`);
    lines.push('');
    lines.push(`TOTAL: ${data.totals.total} medallas`);
    lines.push(`🥇 Oro: ${data.totals.oro}   🥈 Plata: ${data.totals.plata}   🥉 Bronce: ${data.totals.bronce}`);
    lines.push('');

    if (data.totals.total === 0) {
        lines.push('El club no obtuvo medallas (podio) en esta competición.');
        return lines.join('\n');
    }

    lines.push('— POR CATEGORÍA —');
    Object.keys(data.byCat).sort((a, b) => a.localeCompare(b, 'es')).forEach(cat => {
        const c = data.byCat[cat];
        lines.push(`${cat}: ${c.total} (🥇${c.oro} 🥈${c.plata} 🥉${c.bronce})`);
    });

    lines.push('');
    lines.push('— POR PRUEBA —');
    Object.keys(data.byPrueba).sort((a, b) => a.localeCompare(b, 'es')).forEach(p => {
        const pr = data.byPrueba[p];
        lines.push(`${p}: ${pr.total} (🥇${pr.oro} 🥈${pr.plata} 🥉${pr.bronce})`);
    });

    return lines.join('\n');
}

function buildMedalsHtml(data, club) {
    if (data.totals.total === 0) {
        return `<div class="alert alert-info mb-0"><i class="bi bi-info-circle me-2"></i>El ${club} no obtuvo medallas (podio) en esta competición.</div>`;
    }

    const catRows = Object.keys(data.byCat).sort((a, b) => a.localeCompare(b, 'es')).map(cat => {
        const c = data.byCat[cat];
        return `<tr><td>${cat}</td><td>${c.oro}</td><td>${c.plata}</td><td>${c.bronce}</td><td class="fw-bold">${c.total}</td></tr>`;
    }).join('');

    const pruebaRows = Object.keys(data.byPrueba).sort((a, b) => a.localeCompare(b, 'es')).map(p => {
        const pr = data.byPrueba[p];
        return `<tr><td>${p}</td><td>${pr.oro}</td><td>${pr.plata}</td><td>${pr.bronce}</td><td class="fw-bold">${pr.total}</td></tr>`;
    }).join('');

    return `
    <div class="row g-2 text-center mb-4">
        ${medalCard('🥇', data.totals.oro, 'Oros', 'medal-gold')}
        ${medalCard('🥈', data.totals.plata, 'Platas', 'medal-silver')}
        ${medalCard('🥉', data.totals.bronce, 'Bronces', 'medal-bronze')}
        ${medalCard('🏅', data.totals.total, 'Total', 'medal-total')}
    </div>

    <h6 class="fw-bold mt-4 mb-3 text-uppercase text-secondary small">Medallas por categoría</h6>
    <div class="table-responsive">
        <table class="table table-sm table-striped align-middle mb-0">
            <thead><tr><th>Categoría</th><th>🥇</th><th>🥈</th><th>🥉</th><th>Total</th></tr></thead>
            <tbody>${catRows}</tbody>
        </table>
    </div>

    <h6 class="fw-bold mt-4 mb-3 text-uppercase text-secondary small">Medallas por prueba</h6>
    <div class="table-responsive">
        <table class="table table-sm table-striped align-middle mb-0">
            <thead><tr><th>Prueba</th><th>🥇</th><th>🥈</th><th>🥉</th><th>Total</th></tr></thead>
            <tbody>${pruebaRows}</tbody>
        </table>
    </div>`;
}

function medalCard(icon, value, label, cls) {
    return `
    <div class="col-6 col-md-3">
        <div class="medal-card ${cls}">
            <div class="medal-value">${icon} ${value}</div>
            <div class="medal-label">${label}</div>
        </div>
    </div>`;
}

/* =====================================================================
 * Barra de estadísticas y vista previa
 * ===================================================================== */
function renderStats(clubEntries, medals) {
    const athletes = new Set(clubEntries.filter(e => !e.isTeam).map(e => e.id)).size;
    const events   = new Set(clubEntries.map(e => `${e.prueba}|${e.categoria}|${e.sex}`)).size;

    const stats = document.getElementById('statsBar');
    stats.innerHTML = `
        ${statTile('bi-trophy-fill text-warning', medals.totals.total, 'Medallas')}
        ${statTile('bi-people-fill text-primary', athletes, 'Deportistas')}
        ${statTile('bi-flag-fill text-success', events, 'Pruebas')}
        ${statTile('bi-1-circle-fill text-warning', medals.totals.oro, 'Oros')}
    `;
    stats.classList.remove('d-none');
}

function statTile(icon, value, label) {
    return `
    <div class="col">
        <div class="stat-tile">
            <i class="bi ${icon} stat-icon"></i>
            <div class="stat-value">${value}</div>
            <div class="stat-label">${label}</div>
        </div>
    </div>`;
}

function renderPreview(text, format) {
    const body = document.getElementById('previewModalBody');
    body.className = 'modal-body p-4';

    if (format === 'medals') {
        body.innerHTML = state.medalsHtml;
    } else if (format === 'press') {
        body.classList.add('preview-press');
        body.innerHTML = text.split('\n\n')
            .map(par => `<p>${escapeHtml(par).replace(/\n/g, '<br>')}</p>`).join('');
    } else if (format === 'whatsapp') {
        body.classList.add('preview-whatsapp');
        const html = escapeHtml(text)
            .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
            .replace(/_(.+?)_/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
        body.innerHTML = `<div class="wa-bubble">${html}</div>`;
    } else {
        body.classList.add('preview-social');
        body.innerHTML = escapeHtml(text)
            .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    }
    previewModal.show();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
