import React from 'react';

// Four corner brackets, the kind that sit around a printing plate. One shape
// used in two places: around the pane you have just flown to, and around the
// name of the pane you are in down on the rail. Sizing and colour come in as
// custom properties, so both uses are the same object at different scales
// rather than two things that merely look alike.
//
// Brackets rather than a box: a full outline would just be a second border
// drawn a few pixels off the first. Four corners read as an instrument aiming
// at something.
export default function Brackets() {
  return (
    <>
      <span className="bracket-corner bracket-tl" />
      <span className="bracket-corner bracket-tr" />
      <span className="bracket-corner bracket-bl" />
      <span className="bracket-corner bracket-br" />
    </>
  );
}
