import BBox from './BBox';

const EMPTY_ARRAY = [];

// Subroutine bias values from the CFF spec (same as CFFGlyph#bias).
function subrBias(s) {
  if (s.length < 1240) {
    return 107;
  } else if (s.length < 33900) {
    return 1131;
  } else {
    return 32768;
  }
}

/**
 * Decodes CFF charstrings straight into bounding boxes, without building a
 * Path first. This mirrors CFFGlyph#_getPath's charstring decoding and
 * Path#bbox's curve extremum math operation for operation, so the resulting
 * boxes are bit-for-bit identical to `glyph.path.bbox`; it just skips
 * allocating the path and its command objects along the way, which makes
 * cold bbox walks over many glyphs much cheaper.
 */
class CFFBBoxDecoder {
  constructor(font) {
    let cff = font.CFF2 || font['CFF '];
    this.font = font;
    this.cff = cff;
    this.version = cff.version;
    this.buffer = cff.stream.buffer;
    this.charStrings = cff.topDict.CharStrings;
    this.gsubrs = cff.globalSubrIndex || EMPTY_ARRAY;
    this.gsubrBias = subrBias(this.gsubrs);

    // Operand stack. Live operands are stack[rp .. sp - 1]; drawing
    // operators consume them from the bottom (rp) like the original
    // interpreter's shift(), everything else pushes/pops at the top.
    this._stack = new Float64Array(256);
    this._sp = 0;
    this._rp = 0;

    // Subroutine call frames: (pos, end) pairs.
    this._frames = new Int32Array(2 * 64);

    // Memo for the last FDSelect range resolved, valid for
    // _pdFirst <= gid < _pdEnd. CID fonts walk glyphs in runs that share
    // a font dict, so this avoids a binary search per glyph.
    this._pdFirst = 0;
    this._pdEnd = -1;
    this._pdDict = null;

    this._minX = 0;
    this._minY = 0;
    this._maxX = 0;
    this._maxY = 0;
    this._drew = false;
  }

  // Same result as CFFFont#privateDictForGlyph, with the FDSelect range
  // lookup memoized.
  _privateDictForGlyph(gid) {
    let cff = this.cff;
    let fdSelect = cff.topDict.FDSelect;
    if (!fdSelect || fdSelect.version === 0) {
      return cff.privateDictForGlyph(gid);
    }

    if (gid >= this._pdFirst && gid < this._pdEnd) {
      return this._pdDict;
    }

    let ranges = fdSelect.ranges;
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      let mid = (low + high) >> 1;
      if (gid < ranges[mid].first) {
        high = mid - 1;
      } else if (mid < high && gid >= ranges[mid + 1].first) {
        low = mid + 1;
      } else {
        let fdArray = cff.topDict.FDArray;
        let fd = ranges[mid].fd;
        let dict = fdArray[fd] ? fdArray[fd].Private : null;
        this._pdFirst = ranges[mid].first;
        this._pdEnd =
          mid < ranges.length - 1 ? ranges[mid + 1].first : Infinity;
        this._pdDict = dict;
        return dict;
      }
    }

    return null;
  }

  _growStack() {
    let stack = this._stack;
    let sp = this._sp;
    let rp = this._rp;
    if (rp > 0) {
      stack.copyWithin(0, rp, sp);
      this._sp = sp - rp;
      this._rp = 0;
    } else {
      let bigger = new Float64Array(sp * 2);
      bigger.set(stack);
      this._stack = bigger;
    }
  }

  _push(v) {
    let stack = this._stack;
    let sp = this._sp;
    if (sp === stack.length) {
      this._growStack();
      stack = this._stack;
      sp = this._sp;
    }

    stack[sp] = v;
    this._sp = sp + 1;
  }

  _shift() {
    let rp = this._rp;
    if (rp < this._sp) {
      this._rp = rp + 1;
      return this._stack[rp];
    }

    return undefined;
  }

  _pop() {
    let sp = this._sp;
    if (sp > this._rp) {
      this._sp = sp - 1;
      return this._stack[sp - 1];
    }

    return undefined;
  }

  // Same as BBox#addPoint, plus tracking that a drawing operator ran.
  _addPoint(x, y) {
    this._drew = true;

    if (Math.abs(x) !== Infinity) {
      if (x < this._minX) {
        this._minX = x;
      }

      if (x > this._maxX) {
        this._maxX = x;
      }
    }

    if (Math.abs(y) !== Infinity) {
      if (y < this._minY) {
        this._minY = y;
      }

      if (y > this._maxY) {
        this._maxY = y;
      }
    }
  }

  // Path#bbox's bezierCurveTo case: the end point is added whole, then the
  // curve's extrema are added per axis. Adding an extremum for one axis
  // cannot change the other axis (the original passes the current max for
  // it, which is a no-op), so each axis is handled on its own here.
  _curve(x0, y0, c1x, c1y, c2x, c2y, x3, y3) {
    this._addPoint(x3, y3);
    this._curveExtrema(x0, c1x, c2x, x3, true);
    this._curveExtrema(y0, c1y, c2y, y3, false);
  }

  _curveExtrema(p0, p1, p2, p3, isX) {
    let b = 6 * p0 - 12 * p1 + 6 * p2;
    let a = -3 * p0 + 9 * p1 - 9 * p2 + 3 * p3;
    let c = 3 * p1 - 3 * p0;

    if (a === 0) {
      if (b === 0) {
        return;
      }

      let t = -c / b;
      if (0 < t && t < 1) {
        this._curvePoint(p0, p1, p2, p3, t, isX);
      }

      return;
    }

    let b2ac = Math.pow(b, 2) - 4 * c * a;
    if (b2ac < 0) {
      return;
    }

    let t1 = (-b + Math.sqrt(b2ac)) / (2 * a);
    if (0 < t1 && t1 < 1) {
      this._curvePoint(p0, p1, p2, p3, t1, isX);
    }

    let t2 = (-b - Math.sqrt(b2ac)) / (2 * a);
    if (0 < t2 && t2 < 1) {
      this._curvePoint(p0, p1, p2, p3, t2, isX);
    }
  }

  _curvePoint(p0, p1, p2, p3, t, isX) {
    let v =
      Math.pow(1 - t, 3) * p0 +
      3 * Math.pow(1 - t, 2) * t * p1 +
      3 * (1 - t) * Math.pow(t, 2) * p2 +
      Math.pow(t, 3) * p3;

    if (Math.abs(v) === Infinity) {
      return;
    }

    if (isX) {
      if (v < this._minX) {
        this._minX = v;
      }

      if (v > this._maxX) {
        this._maxX = v;
      }
    } else {
      if (v < this._minY) {
        this._minY = v;
      }

      if (v > this._maxY) {
        this._maxY = v;
      }
    }
  }

  decode(gid) {
    const cff = this.cff;
    const version = this.version;
    const buf = this.buffer;
    const str = this.charStrings[gid];
    if (!str) {
      throw new Error(`No charstring for glyph ${gid}`);
    }

    const privateDict = this._privateDictForGlyph(gid) || {};
    const subrs = privateDict.Subrs || EMPTY_ARRAY;
    const subrsBias = subrBias(subrs);
    const nominalWidthX = privateDict.nominalWidthX;
    const variationProcessor = this.font._variationProcessor;

    let pos = str.offset;
    let end = str.offset + str.length;
    if (end > buf.length) {
      throw new Error(`Charstring for glyph ${gid} is out of bounds`);
    }

    let frames = this._frames;
    let depth = 0;

    let width = null;
    let nStems = 0;
    let x = 0,
      y = 0;
    // The path's current point. This usually tracks (x, y), but vvcurveto
    // and hhcurveto with an odd operand count move x or y without emitting
    // a path command, and Path#bbox evaluates the following curve from the
    // last emitted point. Kept separate so the boxes match bit-for-bit.
    let px = 0,
      py = 0;
    let trans = null;
    let vsindex = privateDict.vsindex;

    this._sp = this._rp = 0;
    this._minX = Infinity;
    this._minY = Infinity;
    this._maxX = -Infinity;
    this._maxY = -Infinity;
    this._drew = false;

    main: while (pos < end) {
      const op = buf[pos++];

      if (op >= 32) {
        let v;
        if (op < 247) {
          v = op - 139;
        } else if (op < 251) {
          v = (op - 247) * 256 + buf[pos++] + 108;
        } else if (op < 255) {
          v = -(op - 251) * 256 - buf[pos++] - 108;
        } else {
          v =
            ((buf[pos] << 24) |
              (buf[pos + 1] << 16) |
              (buf[pos + 2] << 8) |
              buf[pos + 3]) /
            65536;
          pos += 4;
        }

        // Inline of _push: the hot path of the interpreter.
        let stack = this._stack;
        let sp = this._sp;
        if (sp === stack.length) {
          this._growStack();
          stack = this._stack;
          sp = this._sp;
        }

        stack[sp] = v;
        this._sp = sp + 1;
        continue;
      }

      switch (op) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          if ((this._sp - this._rp) % 2 !== 0 && width === null) {
            width = this._shift() + nominalWidthX;
          }

          nStems += (this._sp - this._rp) >> 1;
          this._sp = this._rp = 0;
          break;

        case 4: // vmoveto
          if (this._sp - this._rp > 1 && width === null) {
            width = this._shift() + nominalWidthX;
          }

          y += this._shift();
          this._addPoint(x, y);
          px = x;
          py = y;
          break;

        case 5: // rlineto
          while (this._sp - this._rp >= 2) {
            x += this._shift();
            y += this._shift();
            this._addPoint(x, y);
          }

          px = x;
          py = y;
          break;

        case 6: // hlineto
        case 7: {
          // vlineto
          let phase = op === 6;
          while (this._sp - this._rp >= 1) {
            if (phase) {
              x += this._shift();
            } else {
              y += this._shift();
            }

            this._addPoint(x, y);
            px = x;
            py = y;
            phase = !phase;
          }

          break;
        }

        case 8: // rrcurveto
          while (this._sp - this._rp > 0) {
            let c1x = x + this._shift();
            let c1y = y + this._shift();
            let c2x = c1x + this._shift();
            let c2y = c1y + this._shift();
            x = c2x + this._shift();
            y = c2y + this._shift();
            this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
            px = x;
            py = y;
          }

          break;

        case 10: {
          // callsubr
          let index = this._pop() + subrsBias;
          let subr = subrs[index];
          if (subr) {
            if (depth * 2 === frames.length) {
              let bigger = new Int32Array(frames.length * 2);
              bigger.set(frames);
              frames = this._frames = bigger;
            }

            frames[depth * 2] = pos;
            frames[depth * 2 + 1] = end;
            depth++;
            pos = subr.offset;
            end = subr.offset + subr.length;
          }

          break;
        }

        case 11: // return
          if (version >= 2) {
            break;
          }

          if (depth === 0) {
            break main;
          }

          depth--;
          pos = frames[depth * 2];
          end = frames[depth * 2 + 1];
          break;

        case 14: // endchar
          if (version >= 2) {
            break;
          }

          if (this._sp > this._rp && width === null) {
            width = this._shift() + nominalWidthX;
          }

          break;

        case 15: // vsindex
          if (version < 2) {
            throw new Error('vsindex operator not supported in CFF v1');
          }

          vsindex = this._pop();
          break;

        case 16: {
          // blend
          if (version < 2) {
            throw new Error('blend operator not supported in CFF v1');
          }

          if (!variationProcessor) {
            throw new Error('blend operator in non-variation font');
          }

          let vstore =
            cff.topDict.vstore && cff.topDict.vstore.itemVariationStore;
          let blendVector = variationProcessor.getBlendVector(vstore, vsindex);
          let numBlends = this._pop();
          let numOperands = numBlends * blendVector.length;
          let stack = this._stack;
          let rp = this._rp;
          let delta = this._sp - rp - numOperands;
          let base = delta - numBlends;

          for (let i = 0; i < numBlends; i++) {
            let sum = stack[rp + base + i];
            for (let j = 0; j < blendVector.length; j++) {
              sum += blendVector[j] * stack[rp + delta];
              delta++;
            }

            stack[rp + base + i] = sum;
          }

          this._sp -= numOperands;
          break;
        }

        case 19: // hintmask
        case 20: // cntrmask
          if ((this._sp - this._rp) % 2 !== 0 && width === null) {
            width = this._shift() + nominalWidthX;
          }

          nStems += (this._sp - this._rp) >> 1;
          this._sp = this._rp = 0;
          pos += (nStems + 7) >> 3;
          break;

        case 21: // rmoveto
          if (this._sp - this._rp > 2 && width === null) {
            width = this._shift() + nominalWidthX;
          }

          x += this._shift();
          y += this._shift();
          this._addPoint(x, y);
          px = x;
          py = y;
          break;

        case 22: // hmoveto
          if (this._sp - this._rp > 1 && width === null) {
            width = this._shift() + nominalWidthX;
          }

          x += this._shift();
          this._addPoint(x, y);
          px = x;
          py = y;
          break;

        case 24: // rcurveline
          while (this._sp - this._rp >= 8) {
            let c1x = x + this._shift();
            let c1y = y + this._shift();
            let c2x = c1x + this._shift();
            let c2y = c1y + this._shift();
            x = c2x + this._shift();
            y = c2y + this._shift();
            this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
            px = x;
            py = y;
          }

          x += this._shift();
          y += this._shift();
          this._addPoint(x, y);
          px = x;
          py = y;
          break;

        case 25: {
          // rlinecurve
          while (this._sp - this._rp >= 8) {
            x += this._shift();
            y += this._shift();
            this._addPoint(x, y);
            px = x;
            py = y;
          }

          let c1x = x + this._shift();
          let c1y = y + this._shift();
          let c2x = c1x + this._shift();
          let c2y = c1y + this._shift();
          x = c2x + this._shift();
          y = c2y + this._shift();
          this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
          px = x;
          py = y;
          break;
        }

        case 26: // vvcurveto
          if ((this._sp - this._rp) % 2) {
            x += this._shift();
          }

          while (this._sp - this._rp >= 4) {
            let c1x = x;
            let c1y = y + this._shift();
            let c2x = c1x + this._shift();
            let c2y = c1y + this._shift();
            x = c2x;
            y = c2y + this._shift();
            this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
            px = x;
            py = y;
          }

          break;

        case 27: // hhcurveto
          if ((this._sp - this._rp) % 2) {
            y += this._shift();
          }

          while (this._sp - this._rp >= 4) {
            let c1x = x + this._shift();
            let c1y = y;
            let c2x = c1x + this._shift();
            let c2y = c1y + this._shift();
            x = c2x + this._shift();
            y = c2y;
            this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
            px = x;
            py = y;
          }

          break;

        case 28: // shortint
          this._push((((buf[pos] << 8) | buf[pos + 1]) << 16) >> 16);
          pos += 2;
          break;

        case 29: {
          // callgsubr
          let index = this._pop() + this.gsubrBias;
          let subr = this.gsubrs[index];
          if (subr) {
            if (depth * 2 === frames.length) {
              let bigger = new Int32Array(frames.length * 2);
              bigger.set(frames);
              frames = this._frames = bigger;
            }

            frames[depth * 2] = pos;
            frames[depth * 2 + 1] = end;
            depth++;
            pos = subr.offset;
            end = subr.offset + subr.length;
          }

          break;
        }

        case 30: // vhcurveto
        case 31: {
          // hvcurveto
          let phase = op === 31;
          while (this._sp - this._rp >= 4) {
            let c1x, c1y, c2x, c2y;
            if (phase) {
              c1x = x + this._shift();
              c1y = y;
              c2x = c1x + this._shift();
              c2y = c1y + this._shift();
              y = c2y + this._shift();
              x = c2x + (this._sp - this._rp === 1 ? this._shift() : 0);
            } else {
              c1x = x;
              c1y = y + this._shift();
              c2x = c1x + this._shift();
              c2y = c1y + this._shift();
              x = c2x + this._shift();
              y = c2y + (this._sp - this._rp === 1 ? this._shift() : 0);
            }

            this._curve(px, py, c1x, c1y, c2x, c2y, x, y);
            px = x;
            py = y;
            phase = !phase;
          }

          break;
        }

        case 12: {
          const op2 = buf[pos++];
          switch (op2) {
            case 3: {
              // and
              let a = this._pop();
              let b = this._pop();
              this._push(a && b ? 1 : 0);
              break;
            }

            case 4: {
              // or
              let a = this._pop();
              let b = this._pop();
              this._push(a || b ? 1 : 0);
              break;
            }

            case 5: {
              // not
              let a = this._pop();
              this._push(a ? 0 : 1);
              break;
            }

            case 9: // abs
              this._push(Math.abs(this._pop()));
              break;

            case 10: {
              // add
              let a = this._pop();
              let b = this._pop();
              this._push(a + b);
              break;
            }

            case 11: {
              // sub
              let a = this._pop();
              let b = this._pop();
              this._push(a - b);
              break;
            }

            case 12: {
              // div
              let a = this._pop();
              let b = this._pop();
              this._push(a / b);
              break;
            }

            case 14: // neg
              this._push(-this._pop());
              break;

            case 15: {
              // eq
              let a = this._pop();
              let b = this._pop();
              this._push(a === b ? 1 : 0);
              break;
            }

            case 18: // drop
              this._pop();
              break;

            case 20: {
              // put
              let val = this._pop();
              let idx = this._pop();
              if (trans === null) {
                trans = [];
              }

              trans[idx] = val;
              break;
            }

            case 21: {
              // get
              let idx = this._pop();
              this._push(trans === null ? 0 : trans[idx] || 0);
              break;
            }

            case 22: {
              // ifelse
              let s1 = this._pop();
              let s2 = this._pop();
              let v1 = this._pop();
              let v2 = this._pop();
              this._push(v1 <= v2 ? s1 : s2);
              break;
            }

            case 23: // random
              this._push(Math.random());
              break;

            case 24: {
              // mul
              let a = this._pop();
              let b = this._pop();
              this._push(a * b);
              break;
            }

            case 26: // sqrt
              this._push(Math.sqrt(this._pop()));
              break;

            case 27: {
              // dup
              let a = this._pop();
              this._push(a);
              this._push(a);
              break;
            }

            case 28: {
              // exch
              let a = this._pop();
              let b = this._pop();
              this._push(b);
              this._push(a);
              break;
            }

            case 29: {
              // index
              let idx = this._pop();
              let len = this._sp - this._rp;
              if (idx < 0) {
                idx = 0;
              } else if (idx > len - 1) {
                idx = len - 1;
              }

              this._push(this._stack[this._rp + idx]);
              break;
            }

            case 30: {
              // roll
              let n = this._pop();
              let j = this._pop();
              let stack = this._stack;
              let rp = this._rp;

              if (j >= 0) {
                while (j > 0) {
                  let t = stack[rp + n - 1];
                  for (let i = n - 2; i >= 0; i--) {
                    stack[rp + i + 1] = stack[rp + i];
                  }

                  stack[rp] = t;
                  j--;
                }
              } else {
                while (j < 0) {
                  let t = stack[rp];
                  for (let i = 0; i <= n; i++) {
                    stack[rp + i] = stack[rp + i + 1];
                  }

                  stack[rp + n - 1] = t;
                  j++;
                }
              }

              break;
            }

            case 34: {
              // hflex
              let c1x = x + this._shift();
              let c1y = y;
              let c2x = c1x + this._shift();
              let c2y = c1y + this._shift();
              let c3x = c2x + this._shift();
              let c3y = c2y;
              let c4x = c3x + this._shift();
              let c4y = c3y;
              let c5x = c4x + this._shift();
              let c5y = y;
              let c6x = c5x + this._shift();
              let c6y = c5y;
              x = c6x;
              y = c6y;

              this._curve(px, py, c1x, c1y, c2x, c2y, c3x, c3y);
              this._curve(c3x, c3y, c4x, c4y, c5x, c5y, c6x, c6y);
              px = x;
              py = y;
              break;
            }

            case 35: {
              // flex
              x += this._shift();
              y += this._shift();
              let p0x = x,
                p0y = y;
              x += this._shift();
              y += this._shift();
              let p1x = x,
                p1y = y;
              x += this._shift();
              y += this._shift();
              let p2x = x,
                p2y = y;
              x += this._shift();
              y += this._shift();
              let p3x = x,
                p3y = y;
              x += this._shift();
              y += this._shift();
              let p4x = x,
                p4y = y;
              x += this._shift();
              y += this._shift();
              let p5x = x,
                p5y = y;

              this._curve(px, py, p0x, p0y, p1x, p1y, p2x, p2y);
              this._curve(p2x, p2y, p3x, p3y, p4x, p4y, p5x, p5y);
              px = x;
              py = y;
              this._shift(); // fd
              break;
            }

            case 36: {
              // hflex1
              let c1x = x + this._shift();
              let c1y = y + this._shift();
              let c2x = c1x + this._shift();
              let c2y = c1y + this._shift();
              let c3x = c2x + this._shift();
              let c3y = c2y;
              let c4x = c3x + this._shift();
              let c4y = c3y;
              let c5x = c4x + this._shift();
              let c5y = c4y + this._shift();
              let c6x = c5x + this._shift();
              let c6y = y; // dy6 is implied: end at the starting y
              x = c6x;
              y = c6y;

              this._curve(px, py, c1x, c1y, c2x, c2y, c3x, c3y);
              this._curve(c3x, c3y, c4x, c4y, c5x, c5y, c6x, c6y);
              px = x;
              py = y;
              break;
            }

            case 37: {
              // flex1
              let startx = x;
              let starty = y;

              x += this._shift();
              y += this._shift();
              let p0x = x,
                p0y = y;
              x += this._shift();
              y += this._shift();
              let p1x = x,
                p1y = y;
              x += this._shift();
              y += this._shift();
              let p2x = x,
                p2y = y;
              x += this._shift();
              y += this._shift();
              let p3x = x,
                p3y = y;
              x += this._shift();
              y += this._shift();
              let p4x = x,
                p4y = y;

              if (Math.abs(x - startx) > Math.abs(y - starty)) {
                // horizontal
                x += this._shift();
                y = starty;
              } else {
                x = startx;
                y += this._shift();
              }

              let p5x = x,
                p5y = y;
              this._curve(px, py, p0x, p0y, p1x, p1y, p2x, p2y);
              this._curve(p2x, p2y, p3x, p3y, p4x, p4y, p5x, p5y);
              px = x;
              py = y;
              break;
            }

            default:
              throw new Error(`Unknown op: 12 ${op2}`);
          }
          break;
        }

        default:
          throw new Error(`Unknown op: ${op}`);
      }
    }

    if (!this._drew) {
      // No drawing operators ran: same empty box Path#bbox produces.
      return Object.freeze(new BBox(0, 0, 0, 0));
    }

    return Object.freeze(
      new BBox(this._minX, this._minY, this._maxX, this._maxY),
    );
  }
}

export default CFFBBoxDecoder;
