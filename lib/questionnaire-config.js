const SETTORI = {

  onoranze_funebri: {
    label: 'Onoranze Funebri',
    categorie_contenuto: [
      'Servizi offerti (trasporto, vestizione, camera ardente, etc.)',
      'Struttura e sale del commiato',
      'Allestimenti floreali e corone',
      'Frasi di conforto e vicinanza',
      'Anniversari e commemorazioni',
      'Storia e territorio locale',
      'Consigli pratici (burocrazia, documenti, scadenze)',
      'Dietro le quinte / il team al lavoro',
      'Recensioni e testimonianze famiglie assistite',
      'Festività (Ognissanti, commemorazione defunti, etc.)'
    ],
    domanda_prodotti: 'Quali servizi offrite?',
    help_prodotti: 'Es: funerali completi, trasporto, camera ardente, fiori, lapidi, cremazione, servizi cimiteriali... (uno per riga)',
    domanda_eventi: "Ci sono ricorrenze o momenti dell'anno particolarmente importanti per la vostra attività?",
    help_eventi: 'Es: Commemorazione dei defunti (2 Novembre), Ognissanti, festività patronali locali, etc.',
    foto_specifiche: [
      'Foto della struttura / sala del commiato',
      'Foto di allestimenti floreali realizzati',
      'Foto dei veicoli / mezzi funebri',
      'Foto del team',
      'Foto di lapidi / monumenti realizzati'
    ],
    aggettivi_extra: ['Discreta', 'Rispettosa', 'Vicina alle famiglie', 'Presente H24', 'Seria'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Il vostro servizio è attivo H24?', opzioni: ['Sì, siamo reperibili 24 ore su 24', 'Sì, con servizio di guardia notturna', 'No, solo orario di ufficio'] },
      { tipo: 'choice', titolo: 'Gestite anche il servizio fiori internamente?', opzioni: ['Sì, abbiamo un nostro laboratorio floreale', 'Ci appoggiamo a un fiorista di fiducia', 'Non offriamo questo servizio'] },
      { tipo: 'text', titolo: 'Quante sedi/punti di riferimento avete?', help: 'Es: sede principale a Ravanusa + punto di appoggio a Campobello' },
      { tipo: 'choice', titolo: 'Come preferite gestire i post commemorativi (anniversari)?', opzioni: ['Vorremmo pubblicare anniversari dei defunti assistiti (con consenso famiglie)', 'Solo commemorazioni generiche (2 Novembre, Ognissanti, etc.)', 'Preferiamo evitare del tutto questo tipo di post'] }
    ]
  },

  ristorazione: {
    label: 'Ristorazione / Bar / Pasticceria',
    categorie_contenuto: [
      'Piatti del giorno / menu settimanale',
      'Foto dei piatti (food photography)',
      'Dietro le quinte in cucina',
      'Materie prime e fornitori locali',
      'Ricette o curiosità culinarie',
      'Recensioni e feedback clienti',
      'Il team (chef, staff, camerieri)',
      'Eventi (serate a tema, musica, degustazioni)',
      'Offerte e promozioni (pranzo, happy hour, etc.)',
      'Festività e menu speciali (Natale, Pasqua, San Valentino, etc.)',
      'Il locale (interni, esterni, terrazza, location)',
      'Storie del territorio e tradizioni gastronomiche'
    ],
    domanda_prodotti: 'Quali sono i piatti/prodotti di punta del vostro menu?',
    help_prodotti: 'I piatti più richiesti, le specialità della casa, i cavalli di battaglia (uno per riga)',
    domanda_eventi: "Avete serate speciali, eventi o stagionalità particolari durante l'anno?",
    help_eventi: 'Es: cena di San Valentino, menu di Pasqua, serate karaoke, aperitivi estivi, sagre, etc.',
    foto_specifiche: [
      'Foto dei piatti (anche col telefono, con buona luce)',
      'Foto del locale (interni, tavoli, bancone)',
      'Foto degli esterni / dehor / terrazza',
      'Foto dello staff in cucina',
      'Foto delle materie prime / ingredienti freschi'
    ],
    aggettivi_extra: ['Gustosa', 'Genuina', 'Accogliente', 'Casalinga', 'Gourmet'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di locale siete?', opzioni: ['Ristorante / Trattoria', 'Pizzeria', 'Bar / Caffetteria', 'Pasticceria', 'Pub / Birreria', 'Street food / Take away', 'Agriturismo'] },
      { tipo: 'checkbox', titolo: 'Offrite servizi di:', opzioni: ['Pranzo', 'Cena', 'Colazione', 'Aperitivo', 'Happy hour', 'Consegna a domicilio', 'Asporto', 'Catering / eventi privati'] },
      { tipo: 'choice', titolo: 'Cambiate menu regolarmente?', opzioni: ['Sì, menu del giorno / settimanale', 'Menu stagionale (ogni 3-4 mesi)', "Menu fisso tutto l'anno", 'Mix: base fissa + piatti del giorno'] },
      { tipo: 'choice', titolo: 'Avete un servizio di prenotazione?', opzioni: ['Sì, via telefono/WhatsApp', 'Sì, anche online (sito/app)', 'No, solo posti liberi'] }
    ]
  },

  abbigliamento: {
    label: 'Negozio di Abbigliamento / Moda',
    categorie_contenuto: [
      'Nuovi arrivi e collezioni',
      'Outfit del giorno / idee di stile',
      'Behind the scenes (allestimento vetrine, selezione capi)',
      'Offerte, saldi e promozioni',
      'Clienti soddisfatti (con permesso) / look realizzati',
      'Consigli di stile per la stagione',
      'Il negozio (vetrina, interni, camerini)',
      'Brand e marchi trattati',
      'Festività e shopping (Natale, Black Friday, saldi, etc.)',
      'Tendenze moda del momento',
      'Il team / le commesse'
    ],
    domanda_prodotti: 'Che tipo di abbigliamento vendete?',
    help_prodotti: 'Es: donna, uomo, bambino, cerimonia, casual, sportivo, taglie forti, accessori... (uno per riga)',
    domanda_eventi: "Quali sono i momenti chiave dell'anno per il vostro negozio?",
    help_eventi: 'Es: inizio saldi (gennaio/luglio), Black Friday, arrivo collezioni, cerimonie (comunioni, cresime), Natale...',
    foto_specifiche: [
      'Foto dei capi appesi / stesi',
      'Foto outfit completi su manichino o indossati',
      'Foto della vetrina',
      'Foto del negozio (interni)',
      'Video prova capi / unboxing nuovi arrivi'
    ],
    aggettivi_extra: ['Alla moda', 'Trendy', 'Raffinata', 'Per tutti i gusti', 'Esclusiva'],
    domande_extra: [
      { tipo: 'checkbox', titolo: 'A chi vi rivolgete principalmente?', opzioni: ['Donna', 'Uomo', 'Bambino/a', 'Neonato', 'Cerimonia', 'Tutte le categorie'] },
      { tipo: 'choice', titolo: 'Che fascia di prezzo?', opzioni: ['Economica / low-cost', 'Media (buon rapporto qualità/prezzo)', 'Medio-alta', 'Alta / brand di lusso'] },
      { tipo: 'checkbox', titolo: 'Vendete anche:', opzioni: ['Accessori (borse, cinture, sciarpe)', 'Calzature', 'Intimo', 'Costumi mare', 'Gioielli / bigiotteria', 'Solo abbigliamento'] },
      { tipo: 'choice', titolo: 'I clienti possono comprare anche online o solo in negozio?', opzioni: ['Solo in negozio', 'Anche tramite WhatsApp con spedizione', 'Ho un e-commerce online', 'Vorrei iniziare a vendere online'] }
    ]
  },

  alimentari: {
    label: 'Alimentari / Gastronomia / Prodotti Tipici',
    categorie_contenuto: [
      'Prodotti in primo piano (foto con descrizione)',
      'Processo di produzione / raccolta',
      'La storia e il territorio di provenienza',
      'Ricette e suggerimenti di utilizzo',
      'Abbinamenti gastronomici',
      'Novità e prodotti stagionali',
      'Mercati, fiere e sagre',
      'Clienti soddisfatti / recensioni',
      'Confezioni regalo e idee per le feste',
      'Certificazioni e qualità (DOP, IGP, Bio, etc.)',
      'Il team / la famiglia',
      'Curiosità e tradizioni del territorio'
    ],
    domanda_prodotti: 'Elenca i tuoi prodotti principali',
    help_prodotti: 'Tutti i prodotti che vendi/produci, con eventuali formati (uno per riga). Es: Miele di Eucalipto 250g/500g/1kg',
    domanda_eventi: "Partecipate a fiere, sagre, mercatini o eventi durante l'anno?",
    help_eventi: 'Es: sagre estive, mercatini di Natale, fiere agricole, eventi di degustazione...',
    foto_specifiche: [
      'Foto dei singoli prodotti (vasetti, confezioni, etc.)',
      'Foto della produzione / lavorazione',
      'Foto del terreno / campo / laboratorio',
      'Foto delle confezioni regalo',
      'Foto degli stand a fiere/sagre'
    ],
    aggettivi_extra: ['Genuina', 'Artigianale', 'Del territorio', 'A km zero', 'Naturale'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Siete produttori diretti o rivenditori?', opzioni: ['Produttori diretti (produciamo noi)', 'Rivenditori di prodotti altrui', 'Entrambi (produciamo e rivendiamo)'] },
      { tipo: 'checkbox', titolo: 'Avete certificazioni o riconoscimenti?', opzioni: ['Biologico', 'DOP', 'IGP', 'Km 0 / Filiera corta', 'Coltivatore diretto', 'Nessuna certificazione specifica'] },
      { tipo: 'choice', titolo: 'Come vendete i vostri prodotti?', opzioni: ['Solo in sede / punto vendita', 'Anche tramite WhatsApp con spedizione', 'Ho un sito con e-commerce', 'In negozi / rivenditori terzi', 'Un mix di tutti questi canali'] },
      { tipo: 'choice', titolo: 'Offrite confezioni regalo o box degustazione?', opzioni: ['Sì, già pronti a catalogo', 'Sì, personalizzabili su richiesta', 'No, ma vorrei iniziare', 'No, non mi interessa'] }
    ]
  },

  estetica: {
    label: 'Parrucchiere / Estetica / Benessere',
    categorie_contenuto: [
      'Prima e dopo (trattamenti, tagli, colorazioni)',
      'Trattamenti e servizi offerti',
      'Prodotti in vendita / consigliati',
      'Consigli di bellezza e cura personale',
      'Novità (nuove tecniche, macchinari, prodotti)',
      'Il salone / centro estetico (interni, atmosfera)',
      'Il team (presentazione operatrici)',
      'Offerte e pacchetti promozionali',
      'Recensioni e feedback clienti',
      'Trend del momento (colori, tagli, nail art, etc.)',
      'Festività e idee regalo (cofanetti, buoni, etc.)',
      'Dietro le quinte (formazione, corsi, vita del salone)'
    ],
    domanda_prodotti: 'Quali sono i vostri servizi e trattamenti principali?',
    help_prodotti: 'Es: taglio, piega, colore, extension, manicure, pedicure, ceretta, massaggi, trattamenti viso... (uno per riga)',
    domanda_eventi: "Ci sono periodi dell'anno più importanti per il vostro business?",
    help_eventi: 'Es: cerimonie (maggio-giugno), Natale, San Valentino, inizio estate...',
    foto_specifiche: [
      'Foto prima/dopo trattamenti',
      'Foto del salone / centro (interni)',
      'Foto delle postazioni di lavoro',
      'Foto dei prodotti in vendita',
      'Video time-lapse di lavorazioni'
    ],
    aggettivi_extra: ['Curata', 'Rilassante', "All'avanguardia", 'Attenta alla persona', 'Di tendenza'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di attività siete?', opzioni: ['Parrucchiere', 'Centro estetico', 'Salone unisex (parrucchiere + estetica)', 'Centro benessere / SPA', 'Nail bar / centro unghie'] },
      { tipo: 'checkbox', titolo: 'Vendete anche prodotti per la cura a casa?', opzioni: ['Sì, prodotti professionali per capelli', 'Sì, prodotti skincare / cosmetici', 'Sì, una nostra linea a marchio proprio', 'No, solo servizi'] },
      { tipo: 'choice', titolo: 'Come gestite le prenotazioni?', opzioni: ['Solo telefono / WhatsApp', 'Anche tramite app/sito di booking', 'Walk-in (senza appuntamento)', 'Mix appuntamento + walk-in'] },
      { tipo: 'choice', titolo: 'Potete fotografare le clienti dopo i trattamenti (con consenso)?', opzioni: ['Sì, molte clienti sono contente di farsi fotografare', 'Qualcuna sì, ma non tutte', 'Preferiamo usare solo manichini / modelle', 'Non abbiamo mai provato'] }
    ]
  },

  studio_professionale: {
    label: 'Studio Professionale',
    categorie_contenuto: [
      'Servizi offerti (con spiegazione semplice)',
      'Scadenze e promemoria utili per i clienti',
      'Novità normative / fiscali (pillole semplici)',
      'Consigli pratici per aziende e privati',
      'Il team e le competenze',
      'Lo studio (sede, spazi, accoglienza)',
      'Casi di successo (anonimi) / problemi risolti',
      'Recensioni e testimonianze clienti',
      'Festività e auguri professionali',
      'Partecipazione a convegni, corsi, aggiornamenti',
      'FAQ: risposte a domande frequenti',
      'Collaborazioni con altri professionisti'
    ],
    domanda_prodotti: 'Quali servizi professionali offrite?',
    help_prodotti: 'Es: contabilità, dichiarazione dei redditi, consulenza fiscale, paghe, apertura P.IVA, successioni, CAF... (uno per riga)',
    domanda_eventi: 'Quali sono le scadenze/periodi caldi del vostro settore?',
    help_eventi: 'Es: dichiarazioni dei redditi (maggio-settembre), F24, scadenze IVA trimestrali, legge di bilancio, 730...',
    foto_specifiche: [
      'Foto dello studio (reception, uffici)',
      'Foto del team / professionisti',
      'Foto durante convegni o eventi',
      'Logo e materiale grafico esistente'
    ],
    aggettivi_extra: ['Competente', 'Puntuale', 'Chiaro', 'Aggiornato', 'Vicino al cliente'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di studio siete?', opzioni: ['Commercialista / Consulente fiscale', 'Avvocato / Studio legale', 'Consulente del lavoro', 'Studio associato (più specializzazioni)', 'Notaio', 'Architetto / Ingegnere'] },
      { tipo: 'checkbox', titolo: 'I vostri clienti sono principalmente:', opzioni: ['Aziende / Società', 'Liberi professionisti / P.IVA', 'Privati cittadini', 'Enti pubblici / Associazioni'] },
      { tipo: 'choice', titolo: 'Sareste disponibili a scrivere brevi "pillole informative" da pubblicare?', opzioni: ['Sì, posso dettare/scrivere brevi consigli su argomenti fiscali/legali', 'Posso dare le idee, voi le scrivete in modo semplice', 'Preferisco che pensiate a tutto voi'] },
      { tipo: 'choice', titolo: 'Offrite consulenze online/a distanza?', opzioni: ['Sì, anche in videochiamata', 'Solo in sede', 'Stiamo valutando di iniziare'] }
    ]
  },

  erboristeria: {
    label: 'Erboristeria / Farmacia / Sanitario',
    categorie_contenuto: [
      'Prodotti in primo piano (erbe, integratori, cosmetici naturali)',
      'Rimedi naturali e consigli benessere',
      'Proprietà delle piante e degli ingredienti',
      "Stagionalità: cosa usare in ogni periodo dell'anno",
      'Novità e nuovi arrivi',
      'Il negozio / laboratorio',
      'Il team e la competenza (erborista, farmacista)',
      'Ricette e preparazioni (tisane, decotti, etc.)',
      'Recensioni e feedback clienti',
      'Offerte e promozioni',
      'Giornate a tema (es: giornata del benessere, della pelle, etc.)',
      'Curiosità storiche sulle erbe e la fitoterapia'
    ],
    domanda_prodotti: 'Quali sono le vostre categorie di prodotto principali?',
    help_prodotti: 'Es: tisane, oli essenziali, integratori, cosmetici bio, fiori di Bach, prodotti vegani, erbe sfuse... (uno per riga)',
    domanda_eventi: 'Organizzate eventi, giornate promozionali o workshop?',
    help_eventi: 'Es: giornata della cosmesi naturale, consulenze gratuite, laboratori di tisane, promozioni stagionali...',
    foto_specifiche: [
      'Foto dei prodotti sugli scaffali',
      'Foto del negozio / erboristeria (interni)',
      'Foto delle erbe sfuse / ingredienti',
      'Foto di tisane / preparazioni',
      'Foto del laboratorio (se avete produzione propria)'
    ],
    aggettivi_extra: ['Naturale', 'Esperta', 'Attenta al benessere', 'Biologica', 'Olistica'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di attività siete?', opzioni: ['Erboristeria', 'Farmacia con reparto naturale', 'Negozio bio / naturale', 'Parafarmacia', 'Laboratorio galenico / produzione propria'] },
      { tipo: 'checkbox', titolo: 'Quali di questi servizi offrite?', opzioni: ['Consulenza personalizzata in negozio', 'Preparazioni magistrali / personalizzate', 'Vendita online / spedizioni', 'Workshop / corsi', 'Analisi della pelle / capelli'] },
      { tipo: 'choice', titolo: 'Avete una linea di prodotti a marchio proprio?', opzioni: ['Sì, produciamo la nostra linea', 'No, rivendiamo solo brand esterni', 'Stiamo lavorando per crearne una'] },
      { tipo: 'choice', titolo: "Quanto è importante l'aspetto educativo/informativo nella vostra comunicazione?", opzioni: ['Molto — vogliamo educare i clienti sulle proprietà delle piante', 'Abbastanza — un mix di info e promozione', 'Poco — preferiamo puntare sulla promozione prodotti'] }
    ]
  },

  artigianato: {
    label: 'Artigianato / Produzione Locale',
    categorie_contenuto: [
      'I prodotti finiti (foto dettagliate)',
      'Il processo di lavorazione (step by step)',
      'Materie prime utilizzate',
      "La storia dell'artigiano / della bottega",
      'Tradizione e innovazione',
      'Ordini personalizzati / su misura',
      'Mercatini, fiere ed esposizioni',
      'Recensioni clienti / consegne',
      'Confezioni regalo e idee per le feste',
      'Il laboratorio / la bottega',
      'Curiosità sul mestiere e sulle tecniche',
      'Collaborazioni con altri artigiani locali'
    ],
    domanda_prodotti: 'Cosa producete / create?',
    help_prodotti: 'Descrivi i tuoi prodotti artigianali, materiali usati, tecniche (uno per riga)',
    domanda_eventi: "Partecipate a mercatini, fiere, mostre o eventi durante l'anno?",
    help_eventi: 'Es: mercatini di Natale, fiere dell\'artigianato, open day in laboratorio...',
    foto_specifiche: [
      'Foto dei prodotti finiti',
      'Foto del processo di lavorazione',
      'Foto del laboratorio / bottega',
      'Foto delle materie prime',
      'Video della lavorazione (anche col telefono)'
    ],
    aggettivi_extra: ['Fatto a mano', 'Unico', 'Autentico', 'Del territorio', 'Con passione'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di artigianato praticate?', opzioni: ['Ceramica / Terracotta', 'Legno / Falegnameria', 'Tessuti / Sartoria', 'Gioielli / Oreficeria', 'Alimentare artigianale', 'Pelletteria', 'Ferro battuto / Metalli'] },
      { tipo: 'choice', titolo: 'Accettate ordini personalizzati / su misura?', opzioni: ['Sì, la maggior parte dei nostri lavori sono su commissione', 'Sì, ma abbiamo anche prodotti pronti a catalogo', 'No, vendiamo solo prodotti già pronti'] },
      { tipo: 'choice', titolo: 'Vendete anche online?', opzioni: ['Sì, su Etsy', 'Sì, ho un mio sito e-commerce', 'Tramite WhatsApp / social con spedizione', 'Solo di persona (bottega/mercatini)', 'Vorrei iniziare a vendere online'] }
    ]
  },

  turismo: {
    label: 'Turismo / B&B / Hospitality',
    categorie_contenuto: [
      'Le camere e gli spazi (foto professionali)',
      'La colazione / i servizi inclusi',
      'Attrazioni e cose da fare nelle vicinanze',
      'Recensioni e feedback ospiti',
      'Offerte speciali e pacchetti',
      'Il territorio (paesaggi, borghi, spiagge)',
      'Eventi locali (sagre, festival, concerti)',
      'Consigli di viaggio per la zona',
      'Stagionalità (estate/inverno/ponti)',
      'Il team / la famiglia che vi accoglie',
      'Dietro le quinte (preparazione camere, cura dettagli)',
      'Collaborazioni con ristoranti/guide/esperienze locali'
    ],
    domanda_prodotti: 'Che tipo di struttura ricettiva gestite?',
    help_prodotti: 'Descrivi camere/appartamenti, numero posti letto, servizi inclusi (piscina, colazione, parcheggio, etc.)',
    domanda_eventi: 'Quali sono le vostre stagioni/periodi di punta?',
    help_eventi: 'Es: estate (giugno-settembre), ponti, Pasqua, Capodanno, eventi locali che portano turisti...',
    foto_specifiche: [
      'Foto delle camere / appartamenti',
      'Foto degli spazi comuni (giardino, piscina, terrazza)',
      'Foto della colazione / prodotti tipici offerti',
      'Foto panoramiche del territorio',
      'Video tour della struttura'
    ],
    aggettivi_extra: ['Accogliente', 'Autentica', 'Rilassante', 'Panoramica', 'Immersa nella natura'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Che tipo di struttura siete?', opzioni: ['B&B', 'Casa vacanze / Appartamento', 'Agriturismo', 'Hotel', 'Affittacamere', 'Glamping / Camping'] },
      { tipo: 'checkbox', titolo: 'Su quali piattaforme siete presenti per le prenotazioni?', opzioni: ['Booking.com', 'Airbnb', 'TripAdvisor', 'Sito proprio con booking', 'Solo contatto diretto (telefono/email/WhatsApp)', 'Google Hotels'] },
      { tipo: 'checkbox', titolo: 'Che tipo di turisti ospitate di più?', opzioni: ['Famiglie con bambini', 'Coppie', 'Gruppi di amici', 'Turisti stranieri', 'Lavoratori/viaggiatori business', 'Escursionisti / amanti della natura'] },
      { tipo: 'choice', titolo: 'Offrite esperienze oltre al pernottamento?', opzioni: ['Sì (degustazioni, tour, escursioni, cooking class, etc.)', 'No, ma collaboriamo con guide/operatori locali', 'No, solo alloggio', 'Vorremmo iniziare'] }
    ]
  },

  edilizia: {
    label: 'Edilizia / Impiantistica / Servizi Tecnici',
    categorie_contenuto: [
      'Lavori realizzati (prima e dopo)',
      'Cantieri in corso (aggiornamenti)',
      'Servizi offerti (con spiegazione chiara)',
      'Materiali e tecniche utilizzate',
      'Il team al lavoro',
      'Mezzi e attrezzature',
      'Consigli pratici per i clienti (manutenzione, risparmio energetico)',
      'Certificazioni e abilitazioni',
      'Recensioni e testimonianze clienti',
      'Bonus e agevolazioni fiscali attive',
      'Sicurezza sul lavoro',
      'Novità del settore (normative, materiali innovativi)'
    ],
    domanda_prodotti: 'Quali servizi/lavori offrite?',
    help_prodotti: 'Es: ristrutturazioni, impianti elettrici, idraulica, cappotto termico, fotovoltaico, infissi, pittura... (uno per riga)',
    domanda_eventi: "Ci sono periodi dell'anno più favorevoli per il vostro lavoro?",
    help_eventi: 'Es: primavera/estate per lavori esterni, scadenze bonus fiscali, fiere di settore...',
    foto_specifiche: [
      'Foto di lavori completati (prima/dopo)',
      'Foto dei cantieri in corso',
      'Foto del team al lavoro',
      'Foto di mezzi e attrezzature',
      'Video time-lapse di lavorazioni'
    ],
    aggettivi_extra: ['Qualificata', 'Puntuale', 'Precisa', 'Con esperienza', 'Certificata'],
    domande_extra: [
      { tipo: 'choice', titolo: 'Qual è il vostro ambito principale?', opzioni: ['Edilizia generale / Ristrutturazioni', 'Impiantistica elettrica', 'Impiantistica idraulica / termoidraulica', 'Fotovoltaico / Energie rinnovabili', 'Infissi / Serramenti', 'Pittura / Decorazione', 'Più ambiti (impresa completa)'] },
      { tipo: 'choice', titolo: 'Lavorate principalmente con:', opzioni: ['Privati (case, appartamenti)', 'Aziende / Uffici / Negozi', 'Enti pubblici (appalti)', 'Un mix di tutti'] },
      { tipo: 'choice', titolo: 'Fornite preventivi gratuiti?', opzioni: ['Sì, sempre gratuiti e senza impegno', 'Sì, per lavori sopra una certa soglia', 'Sopralluogo gratuito, preventivo a pagamento'] },
      { tipo: 'choice', titolo: 'Vi occupate anche della pratica per bonus fiscali (Superbonus, Ecobonus, etc.)?', opzioni: ['Sì, gestiamo tutto noi (pratica + lavori)', 'Collaboriamo con un tecnico/commercialista', 'No, il cliente deve provvedere autonomamente'] }
    ]
  }
};

// Universal questions for all sectors (sections 1, 2, 4, 5, 6, 7, 8, 9, 10)
const SEZIONI_UNIVERSALI = {
  info_attivita: {
    title: '1. La Tua Attività',
    help: 'Conferma e completa i dati della tua attività',
    domande: [
      { tipo: 'text', titolo: "Nome dell'attività / azienda", required: true },
      { tipo: 'text', titolo: 'Il tuo nome e cognome (referente)', required: true },
      { tipo: 'text', titolo: 'Indirizzo email', help: 'Ti contatteremo a questo indirizzo con la proposta di piano editoriale', required: true },
      { tipo: 'text', titolo: 'Numero di telefono (WhatsApp)', required: true },
      { tipo: 'text', titolo: 'Città e provincia', required: true },
      { tipo: 'text', titolo: 'Sito web (se presente)' },
      { tipo: 'paragraph', titolo: 'Descrivi brevemente la tua attività', help: 'Cosa fate, da quanto tempo, cosa vi rende unici? (3-5 righe)', required: true }
    ]
  },
  presenza_social: {
    title: '2. La Tua Presenza Social Attuale',
    help: 'Aiutaci a capire da dove partiamo',
    domande: [
      { tipo: 'checkbox', titolo: 'Quali piattaforme social utilizzi attualmente?', opzioni: ['Facebook (pagina aziendale)', "Facebook (profilo personale usato per l'attività)", 'Instagram', 'TikTok', 'Google My Business', 'YouTube', 'LinkedIn', 'Nessuna — parto da zero'], required: true },
      { tipo: 'text', titolo: 'Link alla pagina Facebook (se presente)' },
      { tipo: 'text', titolo: 'Link al profilo Instagram (se presente)' },
      { tipo: 'choice', titolo: 'Con che frequenza pubblichi attualmente?', opzioni: ['Mai / Non pubblico', 'Raramente (meno di 1 volta al mese)', 'Qualche volta al mese (1-3 post)', 'Circa 1 volta a settimana', 'Più volte a settimana'], required: true },
      { tipo: 'paragraph', titolo: 'Quali difficoltà hai riscontrato nella gestione dei social?', help: 'Es: mancanza di tempo, non so cosa pubblicare, pochi like, etc.' }
    ]
  },
  obiettivi: {
    title: '4. I Tuoi Obiettivi',
    help: 'Cosa vorresti ottenere dai social media?',
    domande: [
      { tipo: 'checkbox', titolo: 'Quali sono i tuoi obiettivi principali? (scegli fino a 3)', opzioni: ['Farmi conoscere nella mia zona (visibilità locale)', 'Attirare nuovi clienti', 'Fidelizzare i clienti esistenti', 'Vendere prodotti/servizi online', "Costruire un'immagine professionale del brand", 'Promuovere eventi o offerte speciali', 'Mostrare i miei lavori / portfolio', 'Ricevere più recensioni positive', 'Aumentare le visite al mio sito web / negozio'], required: true },
      { tipo: 'choice', titolo: 'Qual è il raggio geografico dei tuoi clienti?', opzioni: ['Solo il mio comune', 'Il mio comune e quelli limitrofi (entro 20-30 km)', 'Tutta la provincia', 'Tutta la Sicilia', 'Tutta Italia', "Anche all'estero"], required: true },
      { tipo: 'paragraph', titolo: "C'è un risultato specifico che ti aspetti dai social?", help: 'Es: "vorrei almeno 5 nuovi contatti al mese", "vorrei che la gente sappia che esistiamo"...' }
    ]
  },
  target: {
    title: '5. Il Tuo Pubblico',
    help: 'Aiutaci a capire a chi ci rivolgiamo',
    exclude_sectors: ['onoranze_funebri'],
    domande: [
      { tipo: 'checkbox', titolo: "Chi sono i tuoi clienti tipici? (fascia d'età)", opzioni: ['18-25 anni', '25-35 anni', '35-50 anni', '50-65 anni', '65+ anni', 'Tutte le età'], required: true },
      { tipo: 'choice', titolo: 'I tuoi clienti sono principalmente:', opzioni: ['Privati / Consumatori finali', 'Aziende / Professionisti', 'Entrambi'], required: true },
      { tipo: 'paragraph', titolo: 'Descrivi il tuo cliente ideale', help: 'Chi è la persona che vorresti raggiungere? Cosa cerca?' },
      { tipo: 'checkbox', titolo: 'Come ti trovano di solito i tuoi clienti?', opzioni: ['Passaparola', 'Passaggio davanti al negozio / attività', 'Ricerca su Google', 'Social media', 'Pubblicità cartacea / volantini', 'Portali di settore'] }
    ]
  },
  identita: {
    title: '6. Identità e Comunicazione',
    help: 'Come vuoi che la tua attività venga percepita sui social?',
    domande: [
      { tipo: 'choice', titolo: 'Che tono di voce preferisci per i post?', opzioni: ['Formale e professionale', 'Cordiale e familiare', 'Elegante e raffinato', 'Simpatico e leggero', 'Emozionale e coinvolgente', 'Diretto e pratico', 'Non saprei — decidete voi'], required: true },
      { tipo: 'choice', titolo: 'Preferisci dare del "tu" o del "voi" / "Lei" ai clienti?', opzioni: ['Tu (informale)', 'Voi (plurale inclusivo)', 'Lei (formale)', 'Dipende dal contesto'], required: true },
      { tipo: 'checkbox', titolo: 'Con quali aggettivi vorresti che i clienti descrivessero la tua attività? (3-5)', opzioni: ['Professionale', 'Affidabile', 'Innovativa', 'Tradizionale', 'Elegante', 'Accessibile', 'Familiare', 'Di qualità', 'Creativa', 'Attenta ai dettagli'], extra_from_sector: true, required: true },
      { tipo: 'paragraph', titolo: "C'è qualcosa che NON vuoi venga comunicato sui social?", help: 'Es: prezzi, promozioni aggressive, temi specifici...' },
      { tipo: 'choice', titolo: 'Usi il dialetto siciliano nella comunicazione?', opzioni: ['Sì, spesso — fa parte della nostra identità', 'Ogni tanto, per espressioni tipiche', 'No, preferisco solo italiano corretto', 'Solo se usato in modo simpatico'] }
    ]
  },
  contenuti: {
    title: '7. Contenuti e Piano Editoriale',
    help: 'Scegli i tipi di contenuto che vorresti vedere sui tuoi canali',
    domande: [
      { tipo: 'checkbox', titolo: 'Quali tipi di contenuto ti interessano di più?', help: 'Scegli tutti quelli che vorresti — li useremo per costruire il tuo piano editoriale', options_from_sector: 'categorie_contenuto', required: true },
      { tipo: 'choice', titolo: 'Quanti post al mese vorresti?', opzioni: ['8 post/mese (2 a settimana)', '12 post/mese (3 a settimana) — consigliato', '16 post/mese (4 a settimana)', '20+ post/mese (5+ a settimana)', 'Non saprei — decidete voi'], required: true },
      { tipo: 'checkbox', titolo: 'In quali giorni/orari pensi che i tuoi clienti siano più attivi?', opzioni: ['Mattina presto (7-9)', 'Metà mattina (9-12)', 'Pausa pranzo (12-14)', 'Pomeriggio (14-18)', 'Sera (18-21)', 'Dopo cena (21-23)', 'Weekend', 'Non saprei'] }
    ]
  },
  materiale: {
    title: '8. Materiale a Disposizione',
    help: 'Cosa puoi fornirci per creare i contenuti?',
    domande: [
      { tipo: 'checkbox', titolo: 'Quale materiale puoi fornirci?', options_from_sector: 'foto_specifiche_plus', required: true },
      { tipo: 'choice', titolo: 'Saresti disponibile a scattare foto/video periodicamente e inviarli via WhatsApp?', opzioni: ['Sì, posso mandare foto/video regolarmente', 'Sì, ma solo occasionalmente (1-2 volte al mese)', 'No, preferisco usare solo materiale grafico creato da voi', 'Vorrei un servizio fotografico professionale'], required: true },
      { tipo: 'choice', titolo: "Hai un'identità grafica definita (logo, colori, font)?", opzioni: ['Sì, ho un brand manual / linee guida', 'Ho solo un logo con colori definiti', 'No — createla voi', 'Ho qualcosa ma vorrei rinnovarla'], required: true }
    ]
  },
  concorrenza: {
    title: '9. Concorrenza e Ispirazioni',
    help: 'Aiutaci a capire il contesto',
    domande: [
      { tipo: 'paragraph', titolo: 'Chi sono i tuoi principali concorrenti nella zona?', help: 'Nomi di attività simili alla tua (2-3 nomi)' },
      { tipo: 'paragraph', titolo: "C'è qualche pagina social che ti piace come stile?", help: 'Incolla link o nomi — anche di altri settori, basta che ti piaccia lo stile' },
      { tipo: 'paragraph', titolo: 'Cosa fanno bene i tuoi concorrenti sui social? E cosa NON vorresti fare?' }
    ]
  },
  gestione: {
    title: '10. Gestione e Ultime Cose',
    help: 'Quasi finito!',
    domande: [
      { tipo: 'choice', titolo: 'Vuoi approvare i post prima della pubblicazione?', opzioni: ['Sì, voglio vedere e approvare ogni post', 'Solo per la prima settimana, poi mi fido', 'No, pubblicate in autonomia', 'Solo per post particolari (promozioni, eventi)'], required: true },
      { tipo: 'choice', titolo: 'Come preferisci comunicare con noi?', opzioni: ['WhatsApp', 'Email', 'Telefonate', 'WhatsApp + Email'], required: true },
      { tipo: 'choice', titolo: 'Vuoi che rispondiamo ai commenti e messaggi sui tuoi social?', opzioni: ['Sì, gestite tutto voi', 'Solo i commenti — i messaggi privati li gestisco io', 'No, rispondo io — voi pensate solo ai contenuti'], required: true },
      { tipo: 'choice', titolo: 'Sei interessato a campagne pubblicitarie a pagamento (Meta Ads)?', help: 'Budget separato dal costo del servizio, pagato direttamente a Meta', opzioni: ['Sì, voglio anche fare pubblicità a pagamento', 'Forse in futuro, per ora solo gestione organica', 'No, solo post organici'], required: true },
      { tipo: 'paragraph', titolo: "C'è qualcos'altro che vorresti dirci?", help: 'Note, richieste particolari, aspettative, domande...' }
    ]
  }
};

function getQuestionnaireConfig(sector) {
  const cfg = SETTORI[sector];
  if (!cfg) return null;

  const sections = [];

  // Section 1: Business Info
  sections.push(SEZIONI_UNIVERSALI.info_attivita);

  // Section 2: Social Presence
  sections.push(SEZIONI_UNIVERSALI.presenza_social);

  // Section 3: Sector-specific
  sections.push({
    title: '3. La Tua Attività nel Dettaglio',
    help: 'Domande specifiche per il settore ' + cfg.label,
    domande: [
      ...cfg.domande_extra,
      { tipo: 'paragraph', titolo: cfg.domanda_prodotti, help: cfg.help_prodotti, required: true },
      { tipo: 'paragraph', titolo: cfg.domanda_eventi, help: cfg.help_eventi }
    ]
  });

  // Section 4: Objectives
  sections.push(SEZIONI_UNIVERSALI.obiettivi);

  // Section 5: Target (excluded for funeral homes)
  if (sector !== 'onoranze_funebri') {
    sections.push(SEZIONI_UNIVERSALI.target);
  }

  // Section 6: Identity
  const identita = JSON.parse(JSON.stringify(SEZIONI_UNIVERSALI.identita));
  // Add sector-specific adjectives to the checkbox
  const adjDomanda = identita.domande.find(d => d.extra_from_sector);
  if (adjDomanda && cfg.aggettivi_extra) {
    adjDomanda.opzioni = [...adjDomanda.opzioni, ...cfg.aggettivi_extra];
  }
  sections.push(identita);

  // Section 7: Content
  const contenuti = JSON.parse(JSON.stringify(SEZIONI_UNIVERSALI.contenuti));
  const contentDomanda = contenuti.domande.find(d => d.options_from_sector === 'categorie_contenuto');
  if (contentDomanda) {
    contentDomanda.opzioni = cfg.categorie_contenuto;
    delete contentDomanda.options_from_sector;
  }
  sections.push(contenuti);

  // Section 8: Materials
  const materiale = JSON.parse(JSON.stringify(SEZIONI_UNIVERSALI.materiale));
  const matDomanda = materiale.domande.find(d => d.options_from_sector === 'foto_specifiche_plus');
  if (matDomanda) {
    matDomanda.opzioni = [...cfg.foto_specifiche, 'Logo in alta qualità (PNG/SVG)', 'Volantini / brochure esistenti', 'Nessun materiale — parto da zero'];
    delete matDomanda.options_from_sector;
  }
  sections.push(materiale);

  // Section 9: Competition
  sections.push(SEZIONI_UNIVERSALI.concorrenza);

  // Section 10: Management
  sections.push(SEZIONI_UNIVERSALI.gestione);

  return { label: cfg.label, sections };
}

function getSectorKeys() {
  return Object.entries(SETTORI).map(([key, cfg]) => ({ key, label: cfg.label }));
}

module.exports = { SETTORI, getQuestionnaireConfig, getSectorKeys };
