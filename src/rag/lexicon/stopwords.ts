/**
 * Built-in stop-word lists, curated for retrieval over policies, regulations,
 * manuals and similar documents.
 *
 * Only function words: articles, prepositions, conjunctions, pronouns,
 * question words and the commonest auxiliaries. Words that change what a rule
 * says are never stop words, even where general-purpose lists include them:
 * negations and exclusions ("no", "sin", "nunca", "solo", "salvo"), modals
 * ("debe", "puede") and quantifiers ("todos", "ninguno", "siempre").
 * {@link PROTECTED_WORDS} enforces that across languages, so a word that is a
 * stop word in one language and a negation in another ("no" in Portuguese and
 * Spanish) is kept.
 *
 * Written for this SDK (no third-party list). Chinese, Japanese and other
 * languages without spaces between words are not covered: their keyword
 * segmentation is the search engine's.
 */

/** Stop words per ISO 639-1 language code, lower-case, written with accents. */
// prettier-ignore
export const STOP_WORDS: Readonly<Record<string, readonly string[]>> = {
  es: [
    'a', 'al', 'ante', 'bajo', 'con', 'contra', 'de', 'del', 'desde', 'durante', 'en', 'entre',
    'hacia', 'hasta', 'mediante', 'para', 'por', 'según', 'sobre', 'tras', 'el', 'la', 'los',
    'las', 'lo', 'un', 'una', 'unos', 'unas', 'y', 'e', 'o', 'u', 'pero', 'aunque', 'porque',
    'pues', 'que', 'qué', 'cual', 'cuál', 'cuales', 'cuáles', 'como', 'cómo', 'cuando', 'cuándo',
    'donde', 'dónde', 'quien', 'quién', 'quienes', 'quiénes', 'cuanto', 'cuánto', 'cuanta',
    'cuánta', 'cuantos', 'cuántos', 'cuantas', 'cuántas', 'si', 'me', 'te', 'se', 'nos', 'os',
    'le', 'les', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros',
    'nuestras', 'yo', 'tú', 'él', 'ella', 'ellos', 'ellas', 'nosotros', 'nosotras', 'usted',
    'ustedes', 'vos', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel',
    'aquella', 'aquellos', 'aquellas', 'esto', 'eso', 'aquello', 'es', 'son', 'era', 'fue', 'ser',
    'sea', 'está', 'están', 'estar', 'estoy', 'hay', 'ha', 'han', 'he', 'haber', 'había', 'muy',
    'también', 'ya', 'entonces', 'así', 'aquí', 'ahí', 'allí', 'acá', 'algo', 'alguien',
  ],
  en: [
    'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from',
    'with', 'about', 'as', 'into', 'onto', 'over', 'under', 'between', 'through', 'during', 'per',
    'via', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'have',
    'has', 'had', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'its', 'our', 'their', 'this', 'that', 'these', 'those', 'what', 'which',
    'who', 'whom', 'whose', 'how', 'when', 'where', 'why', 'if', 'so', 'then', 'there', 'here',
    'also', 'just', 'very', 'too', 'some', 'any',
  ],
  pt: [
    'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'na',
    'nas', 'por', 'pelo', 'pela', 'pelos', 'pelas', 'para', 'com', 'sobre', 'entre', 'até',
    'desde', 'ante', 'após', 'sob', 'e', 'ou', 'mas', 'porque', 'que', 'qual', 'quais', 'como',
    'quando', 'onde', 'quem', 'quanto', 'quanta', 'quantos', 'quantas', 'se', 'me', 'te', 'lhe',
    'lhes', 'eu', 'você', 'vocês', 'ele', 'ela', 'eles', 'elas', 'nós', 'meu', 'minha', 'meus',
    'minhas', 'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'estes', 'estas', 'esse', 'essa',
    'esses', 'essas', 'isto', 'isso', 'aquele', 'aquela', 'aquilo', 'é', 'são', 'era', 'foi',
    'ser', 'está', 'estão', 'estar', 'há', 'tem', 'ter', 'muito', 'também', 'já', 'então', 'aqui',
    'ali', 'aí',
  ],
  fr: [
    'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'au', 'aux', 'et', 'ou', 'mais',
    'en', 'dans', 'sur', 'sous', 'par', 'pour', 'avec', 'chez', 'entre', 'vers', 'que', 'qu',
    'qui', 'quoi', 'quel', 'quelle', 'quels', 'quelles', 'comment', 'quand', 'où', 'si', 'je',
    'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'me', 'te', 'se', 'lui', 'leur', 'mon',
    'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leurs',
    'ce', 'cet', 'cette', 'ces', 'est', 'sont', 'être', 'été', 'était', 'a', 'ont', 'avoir', 'y',
    'aussi', 'très', 'donc',
  ],
  it: [
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'della', 'dei', 'degli',
    'delle', 'a', 'al', 'alla', 'ai', 'agli', 'alle', 'da', 'dal', 'dalla', 'in', 'nel', 'nella',
    'nei', 'con', 'su', 'sul', 'sulla', 'per', 'tra', 'fra', 'e', 'ed', 'o', 'ma', 'che', 'chi',
    'cosa', 'come', 'quando', 'dove', 'quale', 'quali', 'quanto', 'se', 'mi', 'ti', 'si', 'ci',
    'vi', 'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'mia', 'tuo', 'tua', 'suo', 'sua',
    'nostro', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'è', 'sono', 'essere',
    'era', 'ha', 'hanno', 'avere', 'anche', 'molto', 'già',
  ],
  de: [
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    'und', 'oder', 'aber', 'in', 'im', 'an', 'am', 'auf', 'aus', 'bei', 'mit', 'nach', 'von',
    'vom', 'zu', 'zum', 'zur', 'für', 'über', 'unter', 'durch', 'gegen', 'um', 'als', 'wie', 'was',
    'wer', 'wo', 'wann', 'welche', 'welcher', 'welches', 'ob', 'dass', 'ich', 'du', 'er', 'sie',
    'es', 'wir', 'ihr', 'mich', 'mir', 'dich', 'dir', 'sich', 'uns', 'euch', 'ihm', 'ihn', 'ihnen',
    'mein', 'dein', 'sein', 'unser', 'dieser', 'diese', 'dieses', 'ist', 'sind', 'war', 'waren',
    'haben', 'hat', 'hatte', 'wird', 'werden', 'auch', 'sehr', 'schon',
  ],
};

/**
 * Never removed, whatever the language lists or the configuration say:
 * negations, exclusions and limits, in every supported language.
 */
// prettier-ignore
export const PROTECTED_WORDS: readonly string[] = [
  // es
  'no', 'ni', 'sin', 'nunca', 'jamás', 'tampoco', 'solo', 'sólo', 'solamente', 'salvo', 'excepto',
  'menos', 'ningún', 'ninguno', 'ninguna', 'nada', 'nadie',
  // en
  'not', 'nor', 'without', 'never', 'only', 'except', 'unless', 'none', 'nothing', 'nobody',
  // pt
  'não', 'nem', 'sem', 'nenhum', 'nenhuma', 'só', 'somente', 'exceto', 'nunca',
  // fr
  'ne', 'pas', 'sans', 'jamais', 'seulement', 'sauf', 'aucun', 'aucune', 'rien', 'personne',
  // it
  'non', 'senza', 'mai', 'tranne', 'nessuno', 'nessuna', 'niente',
  // de
  'nicht', 'kein', 'keine', 'ohne', 'nie', 'niemals', 'nur', 'außer', 'nichts',
];
