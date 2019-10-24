#!/usr/bin/env node
import * as ts from 'typescript';
import * as bril from './bril';
import {Builder} from './builder';
import {readStdin} from './util';

const opTokens = new Map<ts.SyntaxKind, [bril.ValueOpCode, bril.Type]>([
  [ts.SyntaxKind.PlusToken,               ["add", "int"]],
  [ts.SyntaxKind.AsteriskToken,           ["mul", "int"]],
  [ts.SyntaxKind.MinusToken,              ["sub", "int"]],
  [ts.SyntaxKind.SlashToken,              ["div", "int"]],
  [ts.SyntaxKind.LessThanToken,           ["lt",  "bool"]],
  [ts.SyntaxKind.LessThanEqualsToken,     ["le",  "bool"]],
  [ts.SyntaxKind.GreaterThanToken,        ["gt",  "bool"]],
  [ts.SyntaxKind.GreaterThanEqualsToken,  ["ge",  "bool"]],
  [ts.SyntaxKind.EqualsEqualsToken,       ["eq",  "bool"]],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, ["eq",  "bool"]],
]);

function brilType(node: ts.Node, checker: ts.TypeChecker): bril.Type {
  let tsType = checker.getTypeAtLocation(node);
  if (tsType.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
    return "int";
  } else if (tsType.flags &
             (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) {
    return "bool";
  } else {
    throw "unimplemented type " + checker.typeToString(tsType);
  }
}

/**
 * Compile a complete TypeScript AST to a Bril program.
 */
function emitBril(prog: ts.Node, checker: ts.TypeChecker): bril.Program {
  let builder = new Builder();

  function emitExpr(expr: ts.Expression): bril.ValueInstruction {
    switch (expr.kind) {
    case ts.SyntaxKind.NumericLiteral: {
      let lit = expr as ts.NumericLiteral;
      let val = parseInt(lit.text);
      return builder.buildInt(val);
    }

    case ts.SyntaxKind.TrueKeyword: {
      return builder.buildBool(true);
    }

    case ts.SyntaxKind.FalseKeyword: {
      return builder.buildBool(false);
    }

    case ts.SyntaxKind.Identifier: {
      let ident = expr as ts.Identifier;
      let type = brilType(ident, checker);
      return builder.buildValue("id", [ident.text], type);
    }

    case ts.SyntaxKind.BinaryExpression:
      let bin = expr as ts.BinaryExpression;
      let kind = bin.operatorToken.kind;

      // Handle assignments.
      switch (kind) {
      case ts.SyntaxKind.EqualsToken:
        if (!ts.isIdentifier(bin.left)) {
          throw "assignment to non-variables unsupported";
        }
        let dest = bin.left as ts.Identifier;
        let rhs = emitExpr(bin.right);
        let type = brilType(dest, checker);
        return builder.buildValue("id", [rhs.dest], type, dest.text);
      }

      // Handle "normal" value operators.
      let p = opTokens.get(kind);
      if (!p) {
        throw `unhandled binary operator kind ${kind}`;
      }
      let [op, type] = p;

      let lhs = emitExpr(bin.left);
      let rhs = emitExpr(bin.right);
      return builder.buildValue(op, [lhs.dest, rhs.dest], type);

    // Support call instructions---but only for printing, for now.
    case ts.SyntaxKind.CallExpression:
      let call = expr as ts.CallExpression;
      if (call.expression.getText() === "console.log") {
        let values = call.arguments.map(emitExpr);
        builder.buildEffect("print", values.map(v => v.dest));
        return builder.buildInt(0);  // Expressions must produce values.
      } else {
          //console.log(`Calling ${call.expression.getText()}`);
          // Recursively translate arguments
          let values = call.arguments.map(emitExpr);

          // Push all arguments onto stack
          builder.buildEffect("push", values.map(v => v.dest));

          builder.buildEffect("call", [call.expression.getText()]);

          // Check if effect statement, i.e., a call that is not a subexpression
          if (call.parent.kind === ts.SyntaxKind.ExpressionStatement) {
              return builder.buildInt(0);  // Expressions must produce values
          } else {
              let decl = call.parent as ts.VariableDeclaration;
              let type: bril.Type = "int";
              //let type = brilType(decl, checker);
              let name = (decl.name != undefined) ? decl.name.getText() : undefined;
              return builder.buildValue("retval", [], type, name);
          }
      }

    default:
      throw `unsupported expression kind: ${expr.getText()}`;
    }
  }

  function emit(node: ts.Node) {
    switch (node.kind) {
      // Descend through containers.
      case ts.SyntaxKind.SourceFile:
      case ts.SyntaxKind.Block:
      case ts.SyntaxKind.VariableStatement:
      case ts.SyntaxKind.VariableDeclarationList:
        ts.forEachChild(node, emit);
        break;

      // No-op.
      case ts.SyntaxKind.EndOfFileToken:
        break;

      // Emit declarations.
      case ts.SyntaxKind.VariableDeclaration: {
        let decl = node as ts.VariableDeclaration;
        // Declarations without initializers are no-ops.
        if (decl.initializer) {
          let init = emitExpr(decl.initializer);
          let type = brilType(decl, checker);
          builder.buildValue("id", [init.dest], type, decl.name.getText());
        }
        break;
      }

      // Expressions by themselves.
      case ts.SyntaxKind.ExpressionStatement: {
        let exstmt = node as ts.ExpressionStatement;
        emitExpr(exstmt.expression);  // Ignore the result.
        break;
      }

      // Conditionals.
      case ts.SyntaxKind.IfStatement: {
        let if_ = node as ts.IfStatement;

        // Label names.
        let sfx = builder.freshSuffix();
        let thenLab = "then" + sfx;
        let elseLab = "else" + sfx;
        let endLab = "endif" + sfx;

        // Branch.
        let cond = emitExpr(if_.expression);
        builder.buildEffect("br", [cond.dest, thenLab, elseLab]);

        // Statement chunks.
        builder.buildLabel(thenLab);
        emit(if_.thenStatement);
        builder.buildEffect("jmp", [endLab]);
        builder.buildLabel(elseLab);
        if (if_.elseStatement) {
          emit(if_.elseStatement);
        }
        builder.buildLabel(endLab);

        break;
      }

      // Plain "for" loops.
      case ts.SyntaxKind.ForStatement: {
        let for_ = node as ts.ForStatement;

        // Label names.
        let sfx = builder.freshSuffix();
        let condLab = "for.cond" + sfx;
        let bodyLab = "for.body" + sfx;
        let endLab = "for.end" + sfx;

        // Initialization.
        if (for_.initializer) {
          emit(for_.initializer);
        }

        // Condition check.
        builder.buildLabel(condLab);
        if (for_.condition) {
          let cond = emitExpr(for_.condition);
          builder.buildEffect("br", [cond.dest, bodyLab, endLab]);
        }

        builder.buildLabel(bodyLab);
        emit(for_.statement);
        if (for_.incrementor) {
          emitExpr(for_.incrementor);
        }
        builder.buildEffect("jmp", [condLab]);
        builder.buildLabel(endLab);

        break;
      }

      // Code taken from https://github.com/sampsyo/bril/pull/16
      case ts.SyntaxKind.FunctionDeclaration: {
          //console.log("Got a function!");
          //console.log(node);

          let funcDef = node as ts.FunctionDeclaration;
          if (funcDef.name === undefined) {
              throw `no anonymous functions!`
          }

          let name : string = funcDef.name.getText();
          let args : bril.Arg[] = [];

          //console.log(name);
          for (let p of funcDef.parameters) {
              let argName = p.name.getText();
              let typeString = "";
              if (p.type) {
                  typeString = brilType(p, checker);
              }
              args.push({name: argName, type: typeString} as bril.Arg);
          }

          // The type checker gives a full function type;
          // we want only the return type.
          if (funcDef.type && funcDef.type.getText() !== 'void') {
              let retType : bril.Type;
              if (funcDef.type.getText() === 'number') {
                  retType = "int";
              } else if (funcDef.type.getText() === 'boolean') {
                  retType = "bool";
              } else {
                  throw `unsupported type for function return: ${funcDef.type}`;
              }
              builder.buildFunction(name, retType, args);
          } else {
              builder.buildFunction(name, "void", args);
          }
          if (funcDef.body) {
              emit(funcDef.body);
          }
          break;
      }

      case ts.SyntaxKind.ReturnStatement: {
          let retstmt = node as ts.ReturnStatement;
          if (retstmt.expression) {
              let val = emitExpr(retstmt.expression);
              builder.buildEffect("ret", [val.dest]);
          } else {
              builder.buildEffect("ret", []);
          }
          break;
      }

      default:
        throw `unhandled TypeScript AST node kind ${node.kind}`;
    }
  }

  emit(prog);
  return builder.program;
}

function main() {
  // Get the TypeScript filename.
  let filename = process.argv[2];
  if (!filename) {
    console.error(`usage: ${process.argv[1]} src.ts`)
    process.exit(1);
  }

  // Load up the TypeScript context.
  let program = ts.createProgram([filename], {
    target: ts.ScriptTarget.ES5,
  });
  let checker = program.getTypeChecker();

  // Do a weird dance to look up our source file.
  let sf: ts.SourceFile | undefined;
  for (let file of program.getSourceFiles()) {
    if (file.fileName === filename) {
      sf = file;
      break;
    }
  }
  if (!sf) {
    throw "source file not found";
  }

  // Generate Bril code.
  let brilProg = emitBril(sf, checker);
  process.stdout.write(
    JSON.stringify(brilProg, undefined, 2)
  );
}

// Make unhandled promise rejections terminate.
process.on('unhandledRejection', e => { throw e });

main();
