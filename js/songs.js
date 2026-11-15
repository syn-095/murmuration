// Songs = 4 genres x 2 sections (think verse / chorus). The 3-bit "song" field in every packet carries
// both, so a genre change spreads through the swarm by the same handshake as a key change, and a newcomer
// learns the genre from the first song it hears. All keys contain C major pentatonic.
export const GENRES = ['Dream pop', 'Lo-fi', 'Disco', 'Reggae'];
export const SONGS = [
  { genre: 0, name: 'Dream pop · C major', root: 0, minor: false, prog: [0, 5, 3, 4] },  // I vi IV V
  { genre: 0, name: 'Dream pop · A minor', root: 9, minor: true,  prog: [0, 5, 2, 6] },  // i VI III VII
  { genre: 1, name: 'Lo-fi · F major',     root: 5, minor: false, prog: [0, 5, 1, 4] },  // Imaj7 vi7 ii7 V7
  { genre: 1, name: 'Lo-fi · D minor',     root: 2, minor: true,  prog: [0, 3, 6, 2] },  // i7 iv7 VII III
  { genre: 2, name: 'Disco · A minor',     root: 9, minor: true,  prog: [0, 3, 6, 2] },  // i iv VII III
  { genre: 2, name: 'Disco · G major',     root: 7, minor: false, prog: [0, 4, 5, 3] },  // I V vi IV
  { genre: 3, name: 'Reggae · G major',    root: 7, minor: false, prog: [0, 3, 0, 4] },  // I IV I V
  { genre: 3, name: 'Reggae · E minor',    root: 4, minor: true,  prog: [0, 3, 0, 6] },  // i iv i VII
];
// spontaneous changes stay inside the genre (switch section); a person picks the genre
export const RELATED = [[1], [0], [3], [2], [5], [4], [7], [6]];
