// The office's exports, downloaded from the gateway (Phase 8 Part 2): GET /api/schedule/exports
// streams one file — the Class Schedule (SF-003), the Room Schedule (one file since Phase 11.2), or the Teachers'
// Program (SF-029) — as Word (DOCX) or PDF. These helpers only download and word things; the gateway
// builds the file and names it (Content-Disposition), so every page saves exactly what it sends.
import api from '../services/api';

// What the Export card and "Export this page" call the three exports; the ids are the gateway's.
export const EXPORT_VIEWS = [
  { id: 'class-schedule', view: 'section', name: 'Class Schedule', detail: 'One page per section (form LSPU-ACAD-SF-003).', noun: 'section', nounPlural: 'sections' },
  { id: 'room-schedule', view: 'room', name: 'Room Schedule', detail: "One file, every room, in the office's order.", noun: 'room', nounPlural: 'rooms' },
  { id: 'teachers-program', view: 'professor', name: "Teachers' Program", detail: 'One page per professor (form LSPU-ACAD-SF-029).', noun: 'professor', nounPlural: 'professors' }
];
export const exportViewOf = (view) => EXPORT_VIEWS.find(v => v.view === view) || null;

export const FORMAT_WORDS = { docx: 'Word (DOCX)', pdf: 'PDF' };

// The file's name from the gateway's Content-Disposition header; the fallback only if a proxy ate it.
const fileNameOf = (headers, fallback) => {
  const m = /filename="([^"]+)"/.exec(headers?.['content-disposition'] || '');
  return m ? m[1] : fallback;
};

// Saves a downloaded file through a temporary link, the same way the CSV download does.
const saveBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// Downloads one export. params: { view, format, academicYear, semester, scheduleId, id?, weekGroup? }.
// Returns { fileName, pages }; throws the gateway's own plain refusal as an Error (readable message).
export const downloadExport = async (params) => {
  let res;
  try {
    // A whole college's PDF can take a while to print: a longer timeout than the api default.
    res = await api.get('/schedule/exports', { params, responseType: 'blob', timeout: 180000 });
  } catch (err) {
    throw new Error(await exportErrorMessage(err), { cause: err });
  }
  const fileName = fileNameOf(res.headers, `${params.view}.${params.format}`);
  saveBlob(res.data, fileName);
  const pages = Number(res.headers?.['x-export-pages']);
  return { fileName, pages: Number.isFinite(pages) && pages > 0 ? pages : null };
};

// The gateway's plain words out of a failed blob download (the error body arrives as a Blob).
export const exportErrorMessage = async (err) => {
  const fallback = 'The file could not be made. Check that the gateway is running, then try again.';
  const body = err?.response?.data;
  if (body && typeof body.text === 'function') {
    try {
      const parsed = JSON.parse(await body.text());
      if (parsed?.message) return parsed.message;
    } catch { /* not JSON: fall through */ }
  }
  return err?.response?.data?.message || err?.message || fallback;
};

// "Downloaded "Class-Schedule_2nd-Sem-AY2026-27.docx" (19 pages)."
export const downloadedText = ({ fileName, pages }) => `Downloaded “${fileName}”${pages ? ` (${pages} page${pages === 1 ? '' : 's'})` : ''}.`;
