"""A text format for Bril.

This module defines both a parser and a pretty-printer for a
human-editable representation of Bril programs. There are two commands:
`bril2txt`, which takes a Bril program in its (canonical) JSON format and
pretty-prints it in the text format, and `bril2json`, which parses the
format and emits the ordinary JSON representation.
"""

import lark
import sys
import json

__version__ = '0.0.1'


# Text format parser.

GRAMMAR = """
start: func*

func: CNAME "{" instr* "}"

?instr: const | vop | eop | label

type_decl.5: ":" type
const.4: IDENT [type_decl] "=" "const" lit ";"
vop.3: IDENT [type_decl] "=" CNAME IDENT* ";"
eop.2: CNAME IDENT* ";"
label.1: IDENT ":"

lit: SIGNED_INT  -> int
  | BOOL     -> bool

type: CNAME
BOOL: "true" | "false"
IDENT: ("_"|"%"|LETTER) ("_"|"%"|"."|LETTER|DIGIT)*
COMMENT: /#.*/

%import common.SIGNED_INT
%import common.WS
%import common.CNAME
%import common.LETTER
%import common.DIGIT
%ignore WS
%ignore COMMENT
""".strip()


class JSONTransformer(lark.Transformer):
    def start(self, items):
        return {'functions': items}

    def func(self, items):
        name = items.pop(0)
        return {'name': str(name), 'instrs': items}

    def const(self, items):
        dest = items.pop(0)
        type = items.pop(0).children[0] \
               if isinstance(items[0], lark.tree.Tree) else None
        val = items.pop(0)
        res = {
            'op': 'const',
            'dest': str(dest),
            'value': val,
        }
        if type is not None:
            res['type'] = type
        return res

    def vop(self, items):
        dest = items.pop(0)
        type = items.pop(0).children[0] \
               if isinstance(items[0], lark.tree.Tree) else None
        op = items.pop(0)
        res = {
            'op': str(op),
            'dest': str(dest),
            'args': [str(t) for t in items],
        }
        if type is not None:
            res['type'] = type
        return res

    def eop(self, items):
        op = items.pop(0)
        return {
            'op': str(op),
            'args': [str(t) for t in items],
         }

    def label(self, items):
        name = items.pop(0)
        return {
            'label': name,
        }

    def int(self, items):
        return int(str(items[0]))

    def bool(self, items):
        if str(items[0]) == 'true':
            return True
        else:
            return False

    def type(self, items):
        return str(items[0])


def parse_bril(txt):
    parser = lark.Lark(GRAMMAR)
    tree = parser.parse(txt)
    data = JSONTransformer().transform(tree)
    return json.dumps(data, indent=2, sort_keys=True)


# Text format pretty-printer.

def instr_to_string(instr):
    if instr['op'] == 'const':
        return '{}{} = const {}'.format(
            instr['dest'],
            ': {}'.format(instr['type']) if 'type' in instr else '',
            str(instr['value']).lower(),
        )
    elif 'dest' in instr:
        return '{}{} = {} {}'.format(
            instr['dest'],
            ': {}'.format(instr['type']) if 'type' in instr else '',
            instr['op'],
            ' '.join(instr['args']),
        )
    else:
        return '{} {}'.format(
            instr['op'],
            ' '.join(instr['args']),
        )


def print_instr(instr):
    print('  {};'.format(instr_to_string(instr)))


def print_label(label):
    print('{}:'.format(label['label']))


def print_func(func):
    print('{} {{'.format(func['name']))
    for instr_or_label in func['instrs']:
        if 'label' in instr_or_label:
            print_label(instr_or_label)
        else:
            print_instr(instr_or_label)
    print('}')


def print_prog(prog):
    for func in prog['functions']:
        print_func(func)


# Command-line entry points.

def bril2json():
    print(parse_bril(sys.stdin.read()))


def bril2txt():
    print_prog(json.load(sys.stdin))
