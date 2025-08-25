# @isopodlabs/binary

This package provides a set of utilities for reading and writing binary data in TypeScript.

## ☕ Support My Work  
If you use this package, consider [buying me a tea](https://coff.ee/adrianstephens) to support future updates!  

## Usage

Here is a basic example of how to use the package:

```typescript
import * as binary from '@isopodlabs/binary';

// Define an object to specify how to read a structure, e.g.
const StructSpec = {
    x:  binary.UINT16_LE, // read 16-bit little-endian
    y:  binary.StringType(binary.UINT8, 'utf8') // reads an 8 bit length, and reads a string of that length
};

// Create a new stream from a Uint8Array
const stream = new binary.stream(data);

// Read data from the stream
const myData = binary.read(stream, StructSpec);

// The data should look like {x: 42, y: "Something"}
console.log(myData);

// Create a new stream for output
const stream2 = new binary.growingStream;

// Write data back to a stream
binary.write(stream2, myData);

// Extract written data as a Uint8Array
const data2 = stream2.terminate();
```

**Interfaces**:

- `_stream`: Base interface for stream handling
  - `stream`: Main implementation of _stream
  - `growingStream`: Allows the buffer to grow
  - `endianStream`: Holds a 'be' flag that can be used by numeric readers

- `Type`: something with get and put functions.
- `TypeX`: a `Type`, a function, or a constant. Used to provide things like lengths for strings. If it's a `Type` the value is read from the stream, otherwise it is the result of calling the function or the provided constant.

**Functions**:

- `read(stream, type)`: Read from a stream.
- `write(stream, type, value)`: Write a value to a stream.

## Built-in Types

Note that in the following, `type` is an instance of a `Type`, and that parameters `len`, `offset`, and `test` are `TypeX`s.

### Numeric

Read a (un)signed n-bit bigendian(be=true) or littleendian(be=false) integer, where n is a multiple of 8:

- `UINT(n, be)`
- `INT(n, be)`

The following are pre-defined:
- `UINT8`: Read an 8-bit unsigned integer.
- `INT8`: Read an 8-bit signed integer.
- `UINT16_LE`: Read a 16-bit little-endian unsigned integer.
- `UINT16_BE`: Read a 16-bit big-endian unsigned integer.
- `INT16_LE`: Read a 16-bit little-endian signed integer.
- `INT16_BE`: Read a 16-bit big-endian signed integer.
- `UINT32_LE`: Read a 32-bit little-endian unsigned integer.
- `UINT32_BE`: Read a 32-bit big-endian unsigned integer.
- `INT32_LE`: Read a 32-bit little-endian signed integer.
- `INT32_BE`: Read a 32-bit big-endian signed integer.
- `UINT64_LE`: Read a 64-bit little-endian unsigned integer.
- `UINT64_BE`: Read a 64-bit big-endian unsigned integer.
- `INT64_LE`: Read a 64-bit little-endian signed integer.
- `INT64_BE`: Read a 64-bit big-endian signed integer.

Read a float:
- `Float32_LE`: Read a 32-bit little-endian floating-point number.
- `Float32_BE`: Read a 32-bit big-endian floating-point number.
- `Float64_LE`: Read a 64-bit little-endian floating-point number.
- `Float64_BE`: Read a 64-bit big-endian floating-point number.

When using an `endianStream`, these readers use the endianness specified in the stream:
- `UINT16`: Read a 16-bit unsigned integer with stream-specified endianness.
- `INT16`: Read a 16-bit signed integer with stream-specified endianness.
- `UINT32`: Read a 32-bit unsigned integer with stream-specified endianness.
- `INT32`: Read a 32-bit signed integer with stream-specified endianness.
- `UINT64`: Read a 64-bit unsigned integer with stream-specified endianness.
- `INT64`: Read a 64-bit signed integer with stream-specified endianness.
- `Float32`: Read a 32-bit floating-point number with stream-specified endianness.
- `Float64`: Read a 64-bit floating-point number with stream-specified endianness.

Others:
- `ULEB128`: Read an unsigned LEB128 (Little Endian Base 128) integer.


### Strings

- `StringType(len, encoding?, zeroTerminated?, lenScale?)`: Read a string of length `len` and given `encoding`. `len` can be a reader, a fixed value, or a function.
- `NullTerminatedStringType`: Read a string up to the first 0.
- `RemainingStringType(encoding?, zeroTerminated?)`: Read the remainder of the stream into a string.

### Arrays

- `ArrayType(len, type)`: Read an array of length `len` using the given `type`. `len` can be a reader, a fixed value, or a function.
- `RemainingArrayType(type)`: Read the remainder of the stream into an array of the given `type`.

### Others

- `Struct(spec)`: Read a structured object. Not strictly necessary because any non-reader object is interpreted this way anyway.
- `Remainder`: Read the remainder of the stream into a `Uint8Array`.
- `Buffer(len)`: Read a buffer of length `len`.
- `SkipType(len)`: Skip `len` bytes in the stream.
- `AlignType(align)`: Align the stream to the specified alignment.
- `Discard(type)`: Read and then discard the specified `type`.
- `DontRead<T>()`: Do not read the specified `type` - used to create a placeholder property in an object.
- `SizeType(len, type)`: Truncate the stream to `len` bytes, and read a `type`.
- `OffsetType(offset, type)`: Start from `offset` bytes into the stream, read `type`.
- `MaybeOffsetType(offset, type)`: As `OffsetType`, but returns `undefined` is the offset is 0.
- `Const(value)`: Returns a constant value.
- `Func(func)`: Returns a value from a custom function.
- `FuncType(func)`: Read a type that is returned by a custom function.
- `If(test, true_type, false_type?)`: Evaluates `test` and reads either `true_type` or `false_type`. The result is merged into the enclosing object.
- `Optional(test, type)`: If `test` is truthy, reads `type`.
- `Switch(test, switches)`: Reads one of the types in `switch` based on the result of `test`.

## Transformations

Read types can be transformed using `as`.

- `as(type, maker)`: Read a type and transform it using a maker function.
- `Enum(e)`: Define an enumeration.
- `Flags(e, noFalse)`: Define a set of flags.
- `BitFields(bitfields)`: Define a set of bit fields.

These are predefined for convenience:

- `asHex(type)`: Read a type and transform it to a hexadecimal string.
- `asInt(type, radix?)`: Read a type and transform it to an integer with the specified radix.
- `asFixed(type, fracbits)`: Read a type and transform it to a fixed-point number with the specified fractional bits.
- `asEnum(type, enum)`: Read a type and transform it to an enum value.
- `asFlags(type, enum, noFalse?)`: Read a type and transform it to a flags value.


## Advanced

`ReadType<T>`: obtains the type that will be returned by a particular reader.

`Class`: utility to synthesize a class from a reader spec, allowing inheritence:

```typescript
class MyClass extends binary.Class({
    x:  binary.UINT16_LE,
    y:  binary.StringType(binary.UINT8, 'utf8'),
}) {
  constructor(s: binary.stream) {
    super(s);
  }
}
```

## License

This project is licensed under the MIT License.