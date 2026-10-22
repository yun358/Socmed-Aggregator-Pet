import type { Translation } from 'cortico/core/language.ts';
import type { SocialText } from './index.ts';

const it: Translation<SocialText> = {
  platforms: { reddit: 'Reddit', x: 'X', facebook: 'Facebook', threads: 'Threads', instagram: 'Instagram', youtube: 'YouTube', bilibili: 'Bilibili', rednote: 'Rednote' },

  console: {
    label: 'Social media',
    browser: 'Browser',
    browserMissing: 'Nessun Chrome, Edge, Brave o Chromium trovato',
    panel: { title: 'Social media', description: 'Limiti alla lettura di Coo, accessi, scorrimento automatico giornaliero e contatore totale' },
    envPrompt: { title: 'Social media', description: 'Dice a Coo quali piattaforme può leggere, i limiti per richiesta e come vengono trattate le immagini' },
    vars: {
      'social.platforms': 'Le piattaforme attive',
      'social.maxPosts': 'Post per richiesta',
      'social.maxSec': 'Secondi per richiesta',
      'social.images': 'Come vengono trattate le immagini',
      'social.autoscroll': 'Le attività dello scorrimento automatico giornaliero',
    },
    storage: {
      profile: { label: 'Profilo del browser (accessi alle piattaforme)', note: 'Dopo, ogni piattaforma richiede un nuovo accesso' },
      ocr: { label: 'Dati linguistici OCR', note: "Scaricati di nuovo la prossima volta che si legge un'immagine" },
      digests: { label: 'Esecuzioni dello scorrimento automatico giornaliero' },
      cleared: 'Cancellato',
    },
  },

  config: {
    group: 'Social media',
    maxPosts: { title: 'Post per richiesta', description: 'Il numero massimo di post o video che Coo legge per rispondere a una richiesta, sommando tutte le letture' },
    maxSec: { title: 'Tempo per richiesta', description: 'Il numero massimo di secondi che Coo passa a leggere per rispondere a una richiesta' },
    images: { title: 'Immagini', description: 'ocr: legge il testo nelle immagini su questo computer; model: mostra le immagini al modello (costa di più); skip: solo testo, i post con immagini vengono esclusi' },
    maxTranscriptChars: { title: 'Caratteri di trascrizione per lettura', description: 'Il numero massimo di caratteri della trascrizione di un video per lettura; il resto si legge nelle parti successive' },
    showBrowser: { title: 'Mostra il browser', description: 'Mostra la finestra del browser di Coo mentre legge' },
    browserFile: { title: 'Percorso del browser', description: 'Vuoto: cerca Chrome, Edge, Brave o Chromium' },
    platformEnabled: (name: string) => `${name}: attivo`,
    autoscrollEnabled: { title: 'Scorrimento automatico giornaliero', description: 'Legge post ogni giorno agli orari impostati; poi Coo ti fa un riassunto' },
    autoscrollMaxMinutes: { title: 'Minuti per attività', description: "Il numero massimo di minuti di un'attività dello scorrimento automatico giornaliero" },
  },

  sources: { feed: 'Feed', search: 'Ricerca', account: 'Account', community: 'Community' },

  panel: {
    limitsTitle: 'Ogni richiesta',
    limitsDesc: 'Quanto può leggere Coo, e per quanto tempo, per rispondere a una richiesta.',
    posts: 'Post',
    postsSuffix: 'post',
    time: 'Tempo',
    timeSuffix: 'secondi',
    images: 'Immagini',
    imageModes: { ocr: 'Leggi il testo', model: 'Mostra a Coo', skip: 'Solo testo' },
    imageHints: {
      ocr: 'Legge il testo nelle immagini su questo computer (OCR); i dati linguistici si scaricano al primo uso.',
      model: 'Mostra le immagini al modello, che capisce anche le immagini senza testo; costa di più.',
      skip: 'Esclude i post con immagini e legge solo i post di testo; usa meno token degli altri modi.',
    },
    transcript: 'Trascrizioni',
    transcriptSuffix: 'caratteri per lettura',

    platformsTitle: 'Piattaforme',
    platformsDesc: 'Coo legge le piattaforme attivate qui, in un browser tutto suo, separato da quello che usi tu; accedi una volta per piattaforma.',
    loggedIn: 'Accesso effettuato',
    loggedOut: 'Accesso non effettuato',
    unchecked: 'Non verificato',
    login: 'Accedi',
    checkLogins: 'Verifica gli accessi',
    checking: 'Verifica in corso…',
    browser: 'Browser',
    browserFound: (path: string) => `Usa ${path}`,
    browserMissing: 'Nessun Chrome, Edge, Brave o Chromium trovato. Installane uno o inserisci il percorso di un browser.',
    browserFileMissing: 'Nessun file in questo percorso. Svuota il campo per cercare un browser automaticamente.',
    browserPathPlaceholder: 'Trovato automaticamente',
    showBrowser: 'Mostra il browser',
    showBrowserCheck: 'Mostra la finestra del browser di Coo mentre legge',
    showBrowserHint: 'Alcune piattaforme rifiutano un browser nascosto; attivalo se compaiono verifiche o risultati vuoti.',
    loginOpened: (name: string) => `La finestra di accesso a ${name} è aperta. Chiudila dopo aver effettuato l'accesso.`,

    autoscrollTitle: 'Scorrimento automatico giornaliero',
    autoscrollDesc: 'Legge ogni giorno, alla sua ora, un numero stabilito di post; poi Coo ti fa un riassunto.',
    autoscrollOn: 'Attivo',
    autoscrollCheck: 'Scorri automaticamente ogni giorno',
    maxMinutes: 'Ogni attività al massimo',
    maxMinutesSuffix: 'minuti',
    jobPlatform: 'Piattaforma',
    jobSource: 'Origine',
    jobQuery: 'Cosa leggere',
    queryPlaceholder: { feed: '', search: 'Termini di ricerca', account: 'Account o link del profilo', community: 'Community, come r/wallstreetbets' },
    jobPosts: 'Post',
    jobAt: 'Ora',
    jobTextOnly: 'Solo testo',
    addJob: 'Aggiungi attività',
    removeJob: 'Rimuovi',
    runNow: 'Esegui ora',
    running: 'In esecuzione…',
    noJobs: 'Nessuna attività impostata.',
    jobsSaved: 'Salvato',
    jobInvalid: 'Indica cosa leggere per ogni attività di ricerca, account o community.',
    recentRuns: 'Esecuzioni recenti',
    runAt: 'Quando',
    runJob: 'Attività',
    runResult: 'Risultato',
    runPosts: (n: number) => `${n} post`,
    runFailed: 'Esecuzione non riuscita',
    noRuns: 'Ancora nessuna esecuzione.',

    lifetimeTitle: 'Contatore totale',
    // `since` is a long date such as "8 ottobre 2026"; the 8th and the 11th take the elided "dall'"
    lifetimeDesc: (since: string) => `Tempo trascorso da Coo su ogni piattaforma ${/^(8|11)\b/.test(since) ? "dall'" : 'dal '}${since}.`,
    platform: 'Piattaforma',
    timeSpent: 'Tempo',
    postsRead: 'Post e video',
    transcripts: 'Trascrizioni',
    lastRead: 'Ultima lettura',
    total: 'Totale',
    never: '—',
    reset: 'Azzera',
    resetConfirm: 'Azzerare il contatore totale e ricominciare a contare da adesso?',

    saveFailed: (err: string) => `Salvataggio non riuscito: ${err}`,
    readFailed: (err: string) => `Impossibile leggere le impostazioni: ${err}`,
    outOfRange: (min: number, max: number) => `Inserisci un numero intero da ${min} a ${max}`,
    busy: 'Il browser sta leggendo in background; riprova quando ha finito.',
    loginOpen: 'C’è già una finestra di accesso aperta. Chiudila prima; su Mac, esci da quel browser con Cmd+Q.',
    platformOff: (name: string) => `${name} è disattivato.`,
    jobRunning: 'C’è già un’attività in corso.',
    notRunning: 'Il World dei social media non è in esecuzione.',
    noSuchJob: 'Salva l’attività prima di avviarla.',
    duration: (ms: number) => {
      const m = Math.round(ms / 60000);
      if (m < 1) return `${Math.round(ms / 1000)} s`;
      if (m < 60) return `${m} min`;
      return `${Math.floor(m / 60)} h ${m % 60} min`;
    },
  },
};

export default it;
