-- Aggiunge campo brand_colors alla tabella clients per persistere i 3 colori
-- brand (primario, secondario, terziario) settati da "Importa da Sito" o
-- inseriti manualmente nei picker. Prima erano solo in memoria UI e si
-- perdevano uscendo dalla pagina.
-- Formato: JSON array di stringhe hex es. '["#0c1120","#6b9ef7","#f5c542"]'

ALTER TABLE clients ADD COLUMN brand_colors TEXT;
