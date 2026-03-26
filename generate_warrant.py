#!/usr/bin/env python3
"""
Generate a filled warrant PDF from warrant data passed via stdin as JSON.
Usage: python3 generate_warrant.py <output_path>
Reads warrant JSON from stdin.

Supports:
  type = 'arrest'  -> AO-442 Arrest Warrant
  type = 'search'  -> AO-093 Search and Seizure Warrant
  type = 'bench'   -> AO-442 Arrest Warrant (bench variant)
"""
import sys
import json
import warnings
warnings.filterwarnings('ignore')
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject
import os
import logging
logging.getLogger('pypdf').setLevel(logging.ERROR)

BASE_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE_DIR, 'data')

ARREST_TEMPLATE = os.path.join(DATA_DIR, 'arrest_warrant_template.pdf')
SEARCH_TEMPLATE = os.path.join(DATA_DIR, 'search_warrant_template.pdf')


def s(val):
    return str(val).strip() if val else ''


def fill_arrest_warrant(data, output_path):
    reader = PdfReader(ARREST_TEMPLATE)
    writer = PdfWriter()
    writer.clone_reader_document_root(reader)

    warrant_num   = s(data.get('warrantNumber', ''))
    case_num      = s(data.get('linkedCaseNumber', warrant_num))
    subject       = s(data.get('subject', ''))
    county        = s(data.get('county', ''))
    issued_by     = s(data.get('issuedBy', ''))
    judge         = s(data.get('judge', issued_by))
    issued_at     = s(data.get('issuedAt', ''))
    description   = s(data.get('description', ''))
    offense       = description[:500] if description else f'Arrest Warrant — {county} County, TX'
    city_state    = f'{county} County, Texas'

    dob           = s(data.get('subjectDob', ''))
    subject_desc  = s(data.get('subjectDescription', ''))
    address       = s(data.get('address', ''))
    aliases       = s(data.get('aliases', ''))
    height        = s(data.get('height', ''))
    weight        = s(data.get('weight', ''))
    sex           = s(data.get('sex', ''))
    race          = s(data.get('race', ''))
    hair          = s(data.get('hair', ''))
    eyes          = s(data.get('eyes', ''))
    phone         = s(data.get('phone', ''))
    employment    = s(data.get('employment', ''))
    history       = s(data.get('history', ''))
    agency        = s(data.get('agency', 'State of Texas DOJ'))
    doc_type      = s(data.get('documentType', 'Complaint'))

    page1_fields = {
        'DistLocation1':              'State of Texas',
        'DistState1':                 'Texas',
        'CaseNumber':                 case_num,
        'Defendant':                  subject,
        'name of person to be arrested': subject,
        'Offense':                    offense,
        'Date':                       issued_at,
        'City and state':             city_state,
        'Printed name and title':     f'{judge}',
    }

    page2_fields = {
        'Name of defendantoffender':  subject,
        'Known aliases':              aliases,
        'Last known residence':       address,
        'Date of birth':              dob,
        'Last known employment':      employment,
        'Last known telephone numbers': phone,
        'Height':                     height,
        'Weight':                     weight,
        'Sex':                        sex,
        'Race':                       race,
        'Hair':                       hair,
        'Eyes':                       eyes,
        'Scars tattoos other distinguishing marks': subject_desc,
        'History of violence weapons drug use': history,
        'Investigative agency and address': agency,
    }

    checkbox_map = {
        'Indictment':                            False,
        'Superseding Indictment':                False,
        'Information':                           False,
        'Superseding Information':               False,
        'Complaint':                             False,
        'Probation Violation Petition':          False,
        'Supervised Release Violation Petition': False,
        'Violation Notice':                      False,
        'Order of the Court':                    False,
    }
    if doc_type in checkbox_map:
        checkbox_map[doc_type] = True

    writer.update_page_form_field_values(writer.pages[0], page1_fields)
    writer.update_page_form_field_values(writer.pages[1], page2_fields)

    for page in writer.pages:
        if '/Annots' not in page:
            continue
        for annot_ref in page['/Annots']:
            annot = annot_ref.get_object()
            if annot.get('/Subtype') != '/Widget':
                continue
            field_t = annot.get('/T')
            if field_t is None:
                continue
            field_id = str(field_t)
            if field_id in checkbox_map:
                val = '/On' if checkbox_map[field_id] else '/Off'
                annot.update({
                    NameObject('/V'):  NameObject(val),
                    NameObject('/AS'): NameObject(val),
                })

    with open(output_path, 'wb') as f:
        writer.write(f)


def fill_search_warrant(data, output_path):
    reader = PdfReader(SEARCH_TEMPLATE)
    writer = PdfWriter()
    writer.clone_reader_document_root(reader)

    warrant_num   = s(data.get('warrantNumber', ''))
    case_num      = s(data.get('linkedCaseNumber', warrant_num))
    county        = s(data.get('county', ''))
    issued_by     = s(data.get('issuedBy', ''))
    judge         = s(data.get('judge', issued_by))
    issued_at     = s(data.get('issuedAt', ''))
    city_state    = f'{county} County, Texas'
    description   = s(data.get('description', ''))
    subject       = s(data.get('subject', ''))
    address       = s(data.get('address', ''))
    search_property = address or subject
    items_to_seize  = s(data.get('itemsToSeize', description[:500] if description else ''))
    execute_by    = s(data.get('executeBy', ''))
    magistrate    = s(data.get('magistrate', 'United States Magistrate Judge'))

    page1_fields = {
        'District_Location':    'State of Texas',
        'DistrictName':         'Texas',
        'CaseNo':               case_num,
        'Case No':              case_num,
        'SearchProperty':       search_property,
        'PropertyDescrip':      items_to_seize,
        'of the following person or property located in the': search_property,
        'District of':          'Texas',
        'YOU ARE COMMANDED to execute this warrant on or before': execute_by,
        'as required by law and promptly return this warrant and inventory to': magistrate,
        'Date and time issued': issued_at,
        'City and state':       city_state,
        'Printed name and title': f'{judge}',
    }

    writer.update_page_form_field_values(writer.pages[0], page1_fields)

    daytime_cb = {
        'in the daytime 600 am to 1000 pm': True,
        'at any time in the day or night because good cause has been established': False,
    }
    for page in writer.pages:
        if '/Annots' not in page:
            continue
        for annot_ref in page['/Annots']:
            annot = annot_ref.get_object()
            if annot.get('/Subtype') != '/Widget':
                continue
            field_t = annot.get('/T')
            if field_t is None:
                continue
            field_id = str(field_t)
            if field_id in daytime_cb:
                val = '/On' if daytime_cb[field_id] else '/Off'
                annot.update({
                    NameObject('/V'):  NameObject(val),
                    NameObject('/AS'): NameObject(val),
                })

    with open(output_path, 'wb') as f:
        writer.write(f)


def fill_warrant(data, output_path):
    wtype = s(data.get('type', 'arrest')).lower()
    if wtype == 'search':
        fill_search_warrant(data, output_path)
    else:
        fill_arrest_warrant(data, output_path)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: generate_warrant.py <output_path>', file=sys.stderr)
        sys.exit(1)
    output_path = sys.argv[1]
    data = json.loads(sys.stdin.read())
    fill_warrant(data, output_path)
    print('OK')
