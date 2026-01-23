# Language Syntax

TinyWhale uses an expression-based design where everything evaluates to a value.

## Record Type

PascalCase identifier starts a type declaration:

```
Point
    x: i32
    y: i32
```

## Type Alias

```
Add = (i32, i32) -> i32
```

## Function Binding

Multi-line body with implicit return:

```
compute = (x: i32): i32 ->
    y: i32 = x * 2
    y + 1
```

## Primitive Binding

```
result: i32 = compute(5)
```
