# Language Syntax

TinyWhale uses an expression-based design where everything evaluates to a value.

## Comments

```
# Line comment, everything after # is ignored
x: i32 = 10 # comment after code
temperature: i32<min=-40, # inline comment # max=50> = 20
```

## Primitive Types

```
a: i32 = 42        # 32-bit signed integer
b: i64 = 1000000   # 64-bit signed integer
c: f32 = 3.14      # 32-bit float
d: f64 = 3.14      # 64-bit float
```

## Type Bounds

Refining primitive types with min/max bounds:

```
positive: i32<min=0> = 42
limited: i32<max=100> = 75
age: i32<min=0, max=125> = 30
temperature: i32<min=-40, max=50> = 20
```

Refining lists with size bounds:

```
smallList: i32[]<size=3> = [1, 2, 3]
```

## Record Type

PascalCase identifier starts a type declaration:

```
Point
    x: i32
    y: i32
```

Nested record types:

```
Inner
    val: i32

Outer
    inner: Inner
    x: i32
```

## Record Instantiation

Records are instantiated using `name = TypeName` followed by indented field initializers:

```
p1 = Point
    x = 10
    y = 20

# Field access
sum: i32 = p1.x + p1.y
```

Nested instantiation:

```
o = Outer
    inner: Inner
        val = 42
    x = 10

result: i32 = o.inner.val
```

## Type Alias

Type aliases use uppercase on both sides:

```
Add = (i32, i32) -> i32     # Function type alias
P = Point                    # Record type alias
```

## Function Binding

Single-line with implicit return:

```
double = (x: i32): i32 -> x * 2
```

Single-line with inferred parameter and return types:

```
add: Add = (a, b) -> a + b
```

Multi-parameter function:

```
add = (a: i32, b: i32): i32 -> a + b
```

No-parameter function:

```
get_answer = (): i32 -> 42
```

Multi-line body with implicit return:

```
compute = (x: i32): i32 ->
    y: i32 = x * 2
    y + 1
```

## Primitive Binding

```
x: i32 = 10
result: i32 = compute(5)
```

Variable shadowing:

```
x: i32 = 1
x: i32 = 2   # shadows previous x
```

## Arithmetic Operators

```
a: i32 = 10 + 5     # addition
b: i32 = 10 - 3     # subtraction
c: i32 = 4 * 3      # multiplication
d: i32 = 20 / 4     # division
e: i32 = 10 % 3     # modulo
f: i32 = -7 %% 3    # euclidean modulo
g: i32 = -x         # negation
```

## Comparison Operators

Results are always `i32` (0 or 1):

```
a: i32 = 1 < 2      # less than
b: i32 = 2 > 1      # greater than
c: i32 = 1 <= 1     # less or equal
d: i32 = 2 >= 2     # greater or equal
e: i32 = 1 == 1     # equal
f: i32 = 1 != 2     # not equal
```

Comparison chaining:

```
g: i32 = 1 < 2 < 3  # (1 < 2) && (2 < 3)
```

## Logical Operators

Short-circuit evaluation:

```
a: i32 = 1 && 2     # AND: returns right if left truthy
b: i32 = 0 || 1     # OR: returns first truthy
```

## Bitwise Operators

```
a: i32 = 5 & 3      # AND
b: i32 = 5 | 3      # OR
c: i32 = 5 ^ 3      # XOR
d: i32 = ~5         # NOT
e: i32 = 1 << 4     # left shift
f: i32 = 16 >> 2    # signed right shift
g: i32 = 16 >>> 2   # unsigned right shift
```

## Match Expression

```
x: i32 = 1
result: i32 = match x
    0 -> 100
    1 -> 200
    _ -> 0
```

Or-patterns:

```
result: i32 = match x
    0 | 1 -> 10
    2 | 3 -> 20
    _ -> 0
```

## Lists

```
list: i32[] = [1, 2, 3, 4]
```

Fixed-size lists:

```
nums: i32[]<size=4> = [10, 20, 30, 40]
first: i32 = nums[0]
last: i32 = nums[3]
```

## Combined Example

A complete example combining records, functions, match expressions, and operators:

```
# Define a 2D point with bounded coordinates
Point
    x: i32<min=-100, max=100>
    y: i32<min=-100, max=100>

# Function to compute squared distance from origin
distance_squared = (p: Point): i32 -> p.x * p.x + p.y * p.y

# Function to determine quadrant (1-4) or axis (0)
quadrant = (p: Point): i32 ->
    x_sign: i32 = match p.x > 0
        1 -> 1
        _ -> match p.x < 0
            1 -> -1
            _ -> 0
    y_sign: i32 = match p.y > 0
        1 -> 1
        _ -> match p.y < 0
            1 -> -1
            _ -> 0
    match x_sign + y_sign * 10
        11 -> 1      # +x, +y
        -9 -> 2      # -x, +y
        -11 -> 3     # -x, -y
        9 -> 4       # +x, -y
        _ -> 0       # on axis

# Create points and compute results
origin = Point
    x = 0
    y = 0

p1 = Point
    x = 30
    y = 40

p2 = Point
    x = -15
    y = 25

d1: i32 = distance_squared(p1)    # 2500
q1: i32 = quadrant(p1)           # 1
q2: i32 = quadrant(p2)           # 2
q0: i32 = quadrant(origin)       # 0
```
